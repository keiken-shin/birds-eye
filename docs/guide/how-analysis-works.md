---
title: How Bird's Eye finds duplicates and derivatives
description: An explicit, interactive tour of Bird's Eye's offline scan, hash, perceptual, and heuristic analysis pipeline.
---

# How the analysis works

Bird's Eye is not a file-recovery oracle and it does not use a cloud model to look at your
files. It builds an on-device evidence trail: filesystem facts first, byte identity second,
then deliberately limited heuristics. Every conclusion is either a measured match or a
*proposal for your review*.

<div class="analysis-walkthrough" data-analysis-walkthrough>
<h3>Try the pipeline with a real question</h3>
<p>Choose an example. The walkthrough changes the explanation, not your files. This page never
reads the drive.</p>
<div class="analysis-choices" role="group" aria-label="Choose an example">
  <button class="analysis-choice" type="button" data-analysis-choice="image">JPEG + PNG</button>
  <button class="analysis-choice" type="button" data-analysis-choice="source">PSD → PNG</button>
  <button class="analysis-choice" type="button" data-analysis-choice="binary">BLEND + GLB</button>
  <button class="analysis-choice" type="button" data-analysis-choice="normal">PDF + DOCX</button>
  <button class="analysis-choice" type="button" data-analysis-choice="cache">node_modules</button>
</div>
<div class="analysis-result">
  <div>
    <div class="analysis-result__verdict" data-analysis-verdict></div>
    <div class="analysis-result__headline" data-analysis-title></div>
    <p class="analysis-result__note" data-analysis-note></p>
  </div>
  <ol class="analysis-steps" data-analysis-steps></ol>
</div>
</div>

## The complete pipeline

### 1. Crawl the filesystem

The parallel scanner starts at the folder or drive you choose. Workers share a directory queue,
so several folders can be visited at once. For each entry it records:

- full path, file name, extension, parent folder, and whether it is a file or folder;
- byte size; and
- modified, accessed, and created timestamps when Windows provides them.

It streams progress while it works rather than waiting for a complete inventory. Symbolic links
and directory junctions are not followed, which prevents counting the same tree through an alias.
Hard links are counted once per directory entry name. An inaccessible entry becomes an issue in
the scan; it is not silently treated as empty.

### 2. Persist an index

The writer batches scan events into SQLite transactions. That index is the source for the
workspace: folder rollups, extension and category totals, search, age views, findings, and
duplicate groups all query the same snapshot. A rescan skips a file when its size and modified
time still match. If either changes, its old hashes are invalidated and the file is eligible for
fresh analysis. Missing paths are marked deleted rather than erased from scan history.

### What happens to an ordinary file?

There is no special requirement for a file to be an image or a document. A `.txt`, `.docx`,
`.xlsx`, `.pdf`, `.mp4`, `.zip`, executable, project file, or unknown extension is still an index
record. The extension is lower-cased and used as a hint for coarse classification; it is not
treated as a trustworthy declaration of the bytes inside the file.

The current coarse media classes are `photo`, `video`, `music`, `archive`, `document`, `code`,
`installer`, `model`, and `other`. For example, JPG/PNG/RAW are photos, MP4/MKV/MOV are video,
MP3/FLAC/WAV are music, ZIP/RAR/7Z/TAR are archives, PDF/DOCX/XLSX/TXT/MD are documents, and
RS/JS/TS/PY/HTML/CSS are code. Safetensors, CKPT, PT, PTH, ONNX, and GGUF are models. Formats
outside the whitelist—including PSD, AI, BLEND, GLB, STEP, DWG, ISO, and arbitrary proprietary
formats—usually remain `other` for categorization even though they can still be hashed and
searched. Filename rules can refine a coarse class into things such as screenshot, camera photo,
invoice, or resume.

For normal files, analysis is mostly structural and temporal rather than semantic:

- path and filename rules identify caches, backup locations, installers, source formats, phone
  imports, and sensitive-looking paths;
- size and timestamps support age views and the derivative/backup proposals;
- a small set of safe, bounded header readers extracts PDF titles, JPEG EXIF capture time, ZIP
  entry count, and MP3 ID3 title/artist/album from at most the first 2 MiB; and
- the same duplicate pipeline applies to the bytes regardless of whether the file is text, media,
  an archive, or a proprietary binary.

If a format is not recognized, Bird's Eye does not invent a description. It keeps the measurable
facts, may identify an exact byte duplicate, and otherwise says that it cannot explain more.

### Normal-file recommendations are not duplicate claims

Some findings are about *where a file is* rather than whether another copy exists. Known scratch
paths such as `node_modules`, `.cache`, `target/debug`, `build`, and `dist` are labelled from
their paths. Installer extensions such as `.exe` and `.msi` are labelled as tools. Backup folders
and names can be treated as backup candidates. These findings use the path, name, extension, and
the file's age—not a scan of its contents—and they remain reviewable recommendations.

The Organise view uses a separate catalog pipeline. It groups loose files in configured inbox
zones by coarse media kind, refines names such as screenshots, camera photos, invoices, and
resumes, then chooses a destination in this order: a matching user rule, a learned home outside
the inbox (at least 10 same-kind files and at least 60% of the outside-zone share), or a
conventional home such as Pictures, Documents, Videos, Music, or Software\\Installers. If no
sensible destination can be inferred, it leaves the files alone. This is relocation advice, not
duplicate detection.

One incremental-scan boundary is worth stating plainly: unchanged status is currently determined
by size plus modified time. If software changes bytes while preserving both values, the index can
retain an old hash until a later rescan invalidates it or you force a fresh scan. The app does not
pretend that timestamps are cryptographic content identity.

### 3. Narrow the expensive work

Bird's Eye does not read every byte of every file just to discover duplicates. It first groups
live files by **non-zero size**. A file whose size is unique cannot be byte-for-byte identical to
another file, so it is never sent to the duplicate hasher. Empty files are not useful duplicate
candidates in this staged pass.

The pipeline then works from cheap evidence to strong evidence:

<div class="evidence-grid">
<div class="evidence-card"><h4>Candidate</h4><p>Same size. A collision is possible, not a duplicate verdict.</p><code>size = 8,421,376</code></div>
<div class="evidence-card"><h4>Sampled</h4><p>XXH3 over selected chunks. Fast triage for large files.</p><code>xxh3-sample-v1</code></div>
<div class="evidence-card"><h4>Verified</h4><p>XXH3 over the complete byte stream for strong matches.</p><code>xxh3-full-v1</code></div>
</div>

For files up to 256 KiB, Bird's Eye hashes the whole file immediately. Above that, it hashes
selected 64 KiB blocks: head and tail for medium files, head/middle/tail up to 512 MiB, and five
points (head, 25%, 50%, 75%, tail) for larger files. Only files sharing both size and sampled
hash are promoted to full hashing (up to 64 MiB in the eager verification pass). A full hash is
XXH3-128 over all bytes. Size is included in sampled chunk hashing; offsets and bytes read are
also fed into the hasher.

An exact duplicate therefore means: same recorded size and the same complete bytes, represented
by the same full hash. The hash is an efficient identity check, not a cryptographic proof. If a
file is locked, unavailable, or an online-only cloud placeholder, hashing is skipped and the
reason is surfaced as a scan issue. It is not guessed to be a duplicate.

### How a duplicate group is built

At finalization the index clears and rebuilds its duplicate projections from live, successfully
hashed rows. Groups are partitioned by `size`, then by the available hash fields. The group keeps
the strongest available confidence: `1.0` for a full hash, `0.80` for a sampled hash, and `0.60`
for the lower partial stage. A row with no partial hash is excluded entirely, so two locked files
with the same size cannot become a fake duplicate group.

The UI ranks a group by reclaimable bytes: `size × (member count − 1)`. Keeping one member is
assumed for that estimate; Bird's Eye does not choose which copy you should keep. The duplicate
view can show paths and modified dates, but deciding between the newest, oldest, source, backup,
or protected copy is a user decision. A group is rebuilt after rescans, so disappeared files and
changed hashes stop belonging to the old projection.

The perceptual image path is separate from these byte groups. Its discoveries do not inflate exact
duplicate-group counts and do not become cleanup candidates until a person confirms the relation.

## What “duplicate” means for different formats

### Same type and same format

Two files having the same extension are only candidates for comparison. `report-a.pdf` and
`report-b.pdf` can be completely different documents; `photo.jpg` and `photo-copy.jpg` can be
different photographs. Conversely, an exact copy may have a different name, folder, or timestamp
while retaining the same bytes. Names, extensions, and folder proximity never replace content
verification.

The sequence for two ordinary same-format files is therefore:

1. If their sizes differ, they cannot be exact duplicates and the pair stops there.
2. If their sizes match, the index schedules them as candidates; equal size alone is explicitly
   not a duplicate group.
3. The staged XXH3 sample hash quickly rejects most pairs without reading every byte.
4. Matching candidates up to 64 MiB are full-hashed and grouped by `size + full_hash`. Larger
   matches remain at sampled confidence unless another verification path completes them; a read
   failure likewise leaves the row out of exact groups or at the strongest hash it actually has.

There is no text normalization, PDF semantic comparison, audio fingerprinting, video scene
comparison, archive unpacking, or “same filename means same file” shortcut in the current exact
duplicate engine. A one-byte edit, changed metadata, recompressed image, re-saved document, or
different archive ordering can produce different bytes and therefore a different exact-duplicate
identity.

### JPEG and PNG

The normal duplicate groups are **byte duplicates**, not “these pictures look alike” groups. A
JPEG and a PNG normally have different compression, headers, metadata, and bytes, even when they
render the same pixels. Their sizes and full hashes will therefore differ, so they do **not** land
in an exact duplicate group.

There is a separate, opt-in expensive perceptual populator for common image extensions (JPG/JPEG,
PNG, GIF, WEBP, BMP, HEIC). In the current implementation it reads up to the first 4 MiB of the
file bytes and computes an 8-byte average hash and an 8-byte difference hash. It compares the
combined Hamming distance; a distance of 10 or less emits a `near-duplicate-cluster` discovery.

That is intentionally a triage signal, not proof. Importantly, this implementation does **not**
decode JPEG/PNG pixels or normalize dimensions, crop, rotation, colour, or metadata. It may find
similar byte patterns, and it may miss visually identical cross-format exports. It never silently
turns that signal into a safe deletion. You confirm the discovery in the UI.

<div class="analysis-callout"><strong>Short answer:</strong> Bird's Eye currently knows JPEG and PNG are the same only when their bytes are identical (rare across formats). Its near-duplicate pass can suggest similarity, but it cannot prove pixel equivalence across formats.</div>

## How a derivative is proposed

“Derivative” is a relationship about likely workflow, not a claim that Bird's Eye opened the
source application. The structural heuristic compares files in the same folder and requires all
of the following:

1. The prospective derivative's normalized filename stem equals the source stem, or starts with
   it followed by a delimiter such as a space, `_`, `-`, `.`, `(`, or `[`. This avoids treating
   `art.png` and `artifact.png` as a match.
2. The extensions differ.
3. The derivative's modified time is later than the source's.
4. Both sizes are positive and the derivative/source size ratio is between `0.05` and `50`.

The starter rules separately label `psd`, `ai`, `ae`, `xd`, `aep`, `sketch`, and `fig` as likely
`source` files. The scoring gives an extra confidence nudge when the source is PSD/AI and the
later file is PNG/JPG/JPEG. A match emits a pending `derivedFrom-pattern` discovery. It is not an
automatic relation until the user confirms it.

After a confirmed `derivedFrom` relation exists, the analysis can mark the derivative
`replaceability = regenerable`. That makes it a candidate for a “safe derivative” view; it still
passes the cleanup safety predicate and review gate. The source is not deleted because a
derivative exists, and a same-looking name alone does not establish that the source can recreate
the exact export settings, layers, fonts, linked assets, or edit history.

### PSD, AI, and other creative sources

Bird's Eye does not parse Photoshop, Illustrator, Blender, or CAD project internals. It does not
inspect PSD layers, AI artboards, linked assets, Blender scenes, CAD references, or export history.
For PSD/AI → PNG/JPEG, the proposed relationship comes from extension roles plus the filename,
folder, time, and size heuristics above. If the files are named or arranged differently, the
relationship will not be inferred. If the evidence is ambiguous, the correct result is no
relationship—not a confident story.

## Binary files: BLEND, GLB, CAD, archives, and executables

“Binary” does not mean “unscannable.” The filesystem scanner records binary files just like text
files, and the byte-duplicate pipeline can identify two copies of a `.blend`, `.glb`, `.step`,
`.dwg`, ZIP, executable, or any other readable file when size and complete bytes match.

It cannot currently answer these stronger questions:

- Is `scene.glb` an export from `scene.blend`?
- Is `part.step` derived from a particular Fusion 360/SolidWorks/FreeCAD project?
- Do two Blender files contain the same scene after different save versions or compression?
- Do two CAD files describe the same geometry in different serializations?

Those require format-aware parsers, normalized semantic representations, and often application
metadata or dependency graphs. None of that is present in this app. A `.blend` and `.glb` have
different bytes and different extensions, so they are not exact duplicates; they are not
currently recognized as a source/derivative pair by content. Names such as `model.blend` and
`model.glb` can satisfy the generic same-folder structural heuristic, but that remains a
human-review proposal—not Blender provenance.

## Other analysis passes

### Rules and coarse classification

The cheapest pass applies the starter rule bundle to every live indexed file. Examples include
backup path components such as `Backup` and `Old HDD-Backup`, scratch paths such as `node_modules`,
`.cache`, `target/debug`, `target/release`, `dist`, `build`, and `__pycache__`, system names such
as `Thumbs.db` and `desktop.ini`, design-source extensions, installer extensions, and common
camera/screenshot filename patterns. Sensitive path rules (for example personal details or
passport, payslip, salary, Identity card keywords) are retained as restricted facts and hidden from
global metadata views.

Rules are assertions with a source identifier and confidence. They are not executable cleanup
commands. A filename rule can be wrong, which is why it is visible in the Inspector and why the
cleanup view applies confidence and protection checks again.

### Metadata extraction

The medium-cost extractor is intentionally small and bounded. It reads at most 2 MiB and only
attempts the supported header formats: PDF literal `/Title`; JPEG EXIF-like capture timestamps;
ZIP end-of-central-directory entry count; and MP3 ID3 title, artist, and album frames. It does not
parse DOCX internals, PDF page content, PSD layers, AI artboards, video streams, Blender scenes,
or CAD geometry. Extracted values carry their extractor source and confidence, and restricted
files do not expose those values in global views.

### Catalog and relocation inference

Organise is neither an exact-duplicate engine nor a provenance engine. It identifies candidates in
configured inbox zones, clusters them by kind, and suggests destinations in precedence order:
user-authored rule, learned home, then a cold-start template. Learned homes require at least 10
same-kind files and a dominant outside-zone share of at least 60%. Templates include conventional
homes for photos, videos, music, documents, screenshots, camera photos, invoices, resumes, and
installers. If no sensible destination can be inferred, the files are left alone. A suggestion
carries its evidence, destination, confidence, and capped member list.

Cross-folder backup proposals are more specific than generic derivatives. A file must already be
labelled `backup`; its name is stripped of a trailing ` backup`, `_backup`, `-backup`, ` copy`,
`_copy`, or `-copy`; a candidate origin must be in another folder, have a matching stem boundary,
have a size ratio between `0.5` and `2.0`, and must not itself look like a backup. The origin must
not already be labelled as a backup. This creates a pending `backupOf-pair` proposal at confidence
`0.7`, not a content proof.

## Evidence lifecycle and safety

Internally, a file is an ontology entity linked to its indexed file row. Populators add assertions
such as `role=source`, `role=derivative`, or `replaceability=regenerable`, and relations such as
`derivedFrom`, `backupOf`, or `nearDuplicateOf`. Pattern populators write pending discoveries
instead of immediately asserting those relations. A discovery stores its kind, payload,
confidence, and estimated bytes affected.

Confirming a derived-from proposal creates a user-sourced `derivedFrom` relation and marks the
derivative role. Confirming a backup proposal creates `backupOf` and marks the backup role.
Confirming a near-duplicate proposal creates a bidirectional near-duplicate relation. Rejecting a
proposal records a negative pair decision, so the same rejected relationship is not repeatedly
proposed. Relocation is the exception: confirmation records the decision but does not create an
ontology relation; the physical move is a separate reviewed operation.

Only a confirmed derivative with a surviving source can become `replaceability=regenerable` and
appear as a `safe-derivative` cleanup reason. A confirmed backup is only redundant while its
origin survives. A missing origin protects the backup because it may now be the only copy.

The cleanup candidate view is a live query, not a frozen list. It excludes deleted files, pinned
files, restricted/sensitive files, protected roles, and irreplaceable items. It also applies
confidence thresholds and requires the relevant source/origin relation. Selecting a row narrows
the live result; it cannot resurrect a file that no longer qualifies.

Before mutation, the backend re-verifies the persisted plan against current filesystem metadata
and safety rules. Cleanup uses the Windows Recycle Bin and records enough information for restore;
relocation has its own plan and restore log. A changed, missing, locked, or newly protected file
is held back or refused rather than silently acted upon.

## Budgets, order, and failure modes

Analysis is orchestrated in deterministic cost order:

1. cheap rules;
2. cheap catalog/relocation inference and structural heuristics;
3. medium bounded metadata extraction; and
4. expensive perceptual image hashing.

`cheap-only` runs only the first tier, `standard` includes the medium extractor, and
`all-opt-in` includes the perceptual pass. The app persists each populator's status, cursor,
visited-file count, emitted assertion count, and emitted discovery count. A pause resumes from
that cursor; a completed pass can safely rerun and upsert the same facts without stacking copies.

Read failures do not become positive evidence. Scanner permission errors are recorded as issues;
metadata readers simply emit no fact when a header cannot be read; hash failures exclude the file
from duplicate groups and report the reason. Online-only cloud placeholders are identified before
hashing so they do not trigger a provider download or hang the scan. Cancellation is checked
between files and during hash work, and leaves unfinished work unclassified rather than guessing.

The index is fully local. Paths, timestamps, sizes, hashes, extracted metadata, and file contents
are not sent to a server, and no machine-learning model participates in any of these passes.

## Rules, findings, and safety are separate

The analysis layer runs cheap rule populators for recognizable structure (cache folders, backup
folders, installers, source-format extensions, phone-camera names, and sensitive path patterns).
Medium/expensive populators add metadata and perceptual discoveries. They write assertions and
pending discoveries to the local ontology with a source and confidence, so the Inspector can
show *why* something was suggested.

The UI then maps internal outcomes to three labels:

| Internal evidence | User-facing result |
|---|---|
| Rebuildable, temporary, or confirmed duplicate | **Safe to delete** |
| A heuristic or relationship needing judgement | **Check first** |
| System, in use, pinned, or protected | **Don't touch** |

A finding is not an instruction. Staging is durable and reviewable. Before cleanup, the backend
re-checks the persisted plan and safety predicate; deletion goes to the Windows Recycle Bin.
Moves have the same review gate and a restore log. If a file changed, disappeared, became
protected, or cannot be verified, the action is refused or held back rather than silently applied.

## What the app knows—and what it does not

Bird's Eye knows measured filesystem facts, exact byte identity when hashing succeeds, coarse
image-byte similarity for its supported image extensions, and a bounded set of filename/path/
extension/time/size patterns. It does not know author intent, application provenance, semantic
geometry, pixel equality across formats, or whether a source is truly reproducible unless you
confirm the relationship yourself.

That boundary is the point: the app shows evidence and uncertainty locally, never uploads a path,
hash, or byte, and leaves the final decision with you.
