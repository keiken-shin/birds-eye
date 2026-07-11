# Birds Eye Ontology Layer — Wave 2 Vision

*Companion document to the Wave 1 spec. Captures the cognition-side ambition so it isn't lost while Wave 1 ships.*

*Date: 2026-05-26. Status: Vision (not yet a buildable spec) — **deferred to post-release**; Wave 1 is shipped and this document is the starting point for a future Wave 2 spec, not current scope. Authored alongside the Wave 1 spec to preserve the unified ontology view from the original design dialogue (see `2026-05-26-birds-eye-ontology-chapters-1-6.md`).*

---

## Why Wave 2 exists

Wave 1 of the ontology layer addresses Birds Eye's original mission — reorganize scattered storage and reclaim space through safer, smarter deduplication. It does this by populating just enough of the vocabulary (File / Folder / Project, with role / replaceability / sensitivity / lifecycle, plus the `derivedFrom` / `backupOf` relations) to give the cleanup engine the safety it needs to make brave-enough deletion recommendations.

Wave 2 is what makes Birds Eye a **"Storage Cognition Engine"** rather than just a smarter cleanup tool. It populates the rest of the vocabulary — the **cognition** side — and unlocks a class of questions that have no good answer today:

- "Show me everything related to Death Note across my whole drive."
- "I have two manifestations of Beyblade (2001) in different languages — am I duplicating myself?"
- "Group the contents of my `Toonie_world/` hobby folder by which Work each file is about."
- "Re-color the treemap by the *show* each file belongs to, not by extension."
- "I no longer care about *Big Order* — what files relate to it? Can I clean them all up together?"

These questions are about **rediscovering scattered semantic context** rather than about reclaiming bytes. They make the drive *legible* in a way no folder hierarchy can.

Why ship this as Wave 2, not Wave 1? Because every one of these features is **value-additive** but **not on the critical path for the space-recovery mission**. Wave 1 needs to ship and earn user trust before we expand into the cognition territory.

---

## What Wave 2 brings online

### Vocabulary additions

Wave 1 already *defines* (schema-present, populator-dormant) the cognition classes and relations. Wave 2 populates them. No vocabulary changes, no migrations — only new populator work.

- **Classes activated:** `Work`, `Theme`.
- **Relations activated:** `manifestationOf`, `depicts`.
- **Properties activated:** `language`.

### New populators

**1. Dub-suffix / language-suffix folder pattern recognition.**
Recognizes patterns like `[Eng Dub]`, `[Hindi Dub]`, `[Japanese Sub]`, `(English)`, `(Dub-EN)`, `[ENG]`, regional codes (`-IN-`, `.JP.`), and broader heuristics. Produces `manifestationOf(folder, Work)` edges where the candidate Work title is the folder name minus the suffix, and `language` is the parsed language.

Cleanup-relevant signal: when two folders normalize to the same Work title, they become candidates for the new "Consolidatable Manifestations" cleanup section.

**2. Perceptual-hash thematic clustering.**
The pHash infrastructure Wave 1 already shipped for near-duplicate detection gets reused for fuzzier thematic clustering. Files with embeddings close to each other (but not duplicates) become candidate members of a Theme or candidates for a `depicts` relation to a shared Work.

Example: 47 wallpapers in `Toonie_world/Backgrounds/` cluster by visual similarity into 8 sub-clusters; user labels one cluster "Dragon Ball" → all 8 files in that cluster get `depicts(Work:Dragon-Ball)`.

**3. CLIP-grade image embeddings (optional, opt-in).**
For users who want richer cross-folder thematic discovery. Local ONNX runtime executes a small CLIP image encoder. Embeddings power "show me everything in any folder that visually relates to [this image / this Work]" queries.

Bundle weight is significant (~150 MB ONNX). Strictly opt-in. Wave 2 makes this an installable add-on rather than default.

**4. Filename-based Work-title heuristics.**
For files outside well-formatted folders (`dragon-ball-heroes-thumbpadra1.jpg`), filename tokenization + fuzzy match against an internal Works catalogue surfaces candidate `depicts(Work)` relations.

Internal Works catalogue starts as an empty user-grown list. Each time the user confirms a Work, it enters the catalogue. The system gets smarter with use.

**5. External knowledge lookup (opt-in, behind toggle).**
For users who explicitly enable it: queries to Wikidata, MyAnimeList, IMDB, ISBN databases to resolve Work titles to canonical external IDs.

Privacy guard rail: only the *normalized candidate Work title* is sent — never file paths, never file contents, never hashes. User-visible "Privacy — what gets sent?" panel explains exactly which strings leave the machine.

Disabled by default to honor Birds Eye's offline-first promise. The user opts in for richer Work data; the user opts out at any time.

### User-facing surfaces Wave 2 adds

**New cleanup section: "Consolidatable Manifestations."**

Surfaces Works for which the user has multiple disk manifestations. Example UI:

> *Beyblade (2001)* — 2 manifestations on disk:
> - `Stream/anime/Beyblade (2001) [Eng Dub]/` — 9.2 GB, English
> - `Stream/anime/Beyblade (2001) [Hindi Dub]/` — 8.8 GB, Hindi
>
> *Keep both — Keep one — Manual review*

User decision is *per-Work*, not per-file. Cleanup engine respects the choice and bundles file-level operations underneath.

**New saved view: "All files relating to a Work."**

User picks a Work from a list of all Works detected on disk. Result: every File with `manifestationOf` *or* `depicts` to that Work, across all folders. The Death-Note-across-folders question, answered in one click.

**New saved view: "Works I no longer care about."**

User-driven. Marks Works (not files) as `interest=archived`. All files relating to those Works become cleanup candidates en masse, treated as a single "consolidatable group" with the normal safety guards.

**New treemap lens: "Color by Work."**

Particularly powerful for `Stream/`. Each Work becomes a color; episodes/manifestations of that Work share the color. Suddenly the treemap shows "my media library by show," not "by folder structure."

**New "Cognition" sidebar panel.**

Bringing together cross-cutting cognition queries:
- "Works with multiple manifestations" (consolidation candidates)
- "Works depicted but not owned" (e.g., Death Note wallpapers but no series)
- "Works owned but not depicted" (e.g., owned series with no fan art)
- "Largest Works by total disk footprint"
- "Themes you have files for but haven't named"

### Discoveries panel additions

Wave 1's Discoveries panel gains new categories:

- **Manifestation grouping suggestions** — "These 4 folders look like manifestations of *Doraemon* in different languages. Group them as one Work?"
- **Depicts suggestions** — "12 files in `Toonie_world/Backgrounds/` visually cluster with files you've labeled *Dragon Ball*. Apply `depicts(Dragon Ball)` to all 12?"
- **Theme detection** — "`Toonie_world/` looks like a Theme that crosses many Works. Name it?"
- **Work consolidation prompts** — "You have multiple folders normalizing to `Friends (1994)`. Same Work?"

All retain the same trust hierarchy: pattern-level confirmation, ranked by ROI, never load-bearing for cleanup until confirmed.

---

## Worked examples (Wave 2 in motion)

### Example A — Beyblade dubs consolidation

User scans drive. Wave 2 dub-suffix rule fires on:
- `Stream/anime/Beyblade (2001) [Eng Dub]/` → `manifestationOf(folder, Work:Beyblade-2001)`, `language=en`
- `Stream/anime/Beyblade (2001) [Hindi Dub]/` → `manifestationOf(folder, Work:Beyblade-2001)`, `language=hi`

Both edges asserted at confidence 0.95 (rule-based, high-precision).

Cleanup engine's new "Consolidatable Manifestations" section surfaces *Beyblade (2001)* with the two-manifestation summary. User decides:
- "Keep both" → No-op. Manifestation grouping recorded for future browsing/queries.
- "Keep one" → Choose which language; the other folder enters the cleanup queue (with Recycle-bin-first execution).
- "Manual review" → User browses each manifestation, picks file-level operations.

### Example B — Death Note across folders

Wave 2 perceptual clustering + filename heuristics fire on `Toonie_world/Backgrounds/`. The 13 Death-Note-related JPG/PNGs cluster together; filename tokens (`death-note`, `Deathnote`, `DN`, `DEATH-NOTE-OST`) match a fuzzy Work-title pattern.

Discoveries surfaces: *"13 files look like they depict Death Note. Apply `depicts(Death Note)` to all 13?"*

User confirms. New saved view "All files relating to Death Note" returns all 13. User browses, decides whether to consolidate them in one folder (Wave 2 still does not move files; it just makes them findable).

If user later marks `Work:Death Note` as `interest=archived`, all 13 files become cleanup candidates as a group.

### Example C — Toonie_world Theme

Wave 2 Theme detection notices that:
- `Toonie_world/` contains files associated with many different Works.
- There's no project lifecycle attached.
- Files in it cross multiple types (PSD, JPG, MP4, GIF).

Discoveries suggests: *"`Toonie_world/` looks like a Theme rather than a Project. Name it?"*

User names it "Cartoon hobby." Theme entity created. All files inside get `partOf(Theme:Cartoon hobby)`. Now:
- "Files in my Cartoon hobby theme" is a saved view.
- Treemap "Color by Theme" lens highlights the Cartoon-hobby footprint across the drive.
- Future thematic clustering can suggest "this file in `Downloads/` looks like it might belong to the Cartoon hobby theme — add it?"

### Example D — Color-by-Work treemap on Stream/

User opens treemap, switches lens to "Color by Work." `Stream/` (which today is one big undifferentiated rectangle of video bytes) suddenly becomes a mosaic — each Work a color, each manifestation a sub-rectangle. The user can see at a glance: *"My Friends (1994) library is huge. My Big Order is small. Most of Stream/ is anime, not movies."*

This is the kind of "wow moment" that justifies the cognition investment.

---

## Wave 2's load-bearing assumptions

Wave 2 assumes that Wave 1 has already shipped and ironed out:

- The two-phase scan with pauseable enrichment. Wave 2's populators (especially CLIP embeddings) add real cost; they must integrate into the existing budget framework, not invent a new one.
- The Discoveries panel with pattern-level confirmation. Wave 2 adds new Discovery categories but doesn't change the UX.
- The cleanup engine's gating-fact transparency. Wave 2's "Consolidatable Manifestations" section uses the same provenance display.
- The constitutional 8 defenses. Wave 2 adds no new safety rules; it inherits and respects all of them.
- The vocabulary versioning + migration system. Activating dormant relations does not require a migration; populator additions do not change schema.

If Wave 1 ships with these foundations correct, Wave 2 is *purely additive*: new populators, new UI surfaces, new saved views, no architectural rework.

---

## What's deliberately deferred past Wave 2

These come up naturally in the design dialogue but belong neither in Wave 1 nor in Wave 2's first cut:

- **`Person` and `Event` entities.** "These photos are from college fest 2018." "This person appears in 47 photos across my drive." Face recognition and event extraction add privacy weight and ML complexity. Belongs in a v3+.
- **`Series` / `Season` sub-Work modelling.** For shows with many seasons, episode-level structure under a Work is cleaner than flat manifestations. Punt until users ask "show me only S2 of Friends."
- **Encrypted index storage.** Wave 1 stores the SQLite index in plaintext. v3+ may add at-rest encryption for the index itself, separately from filesystem encryption.
- **Multi-machine federation.** "Reconcile what I have here against what's on my laptop." Out of scope; Birds Eye is single-machine.
- **AI-assisted file content summarization** (e.g., "what's this PDF about?"). Heavy ML, only marginal alignment with the cognition-engine mission. Defer indefinitely.

---

## Open questions Wave 2 will need to answer when its spec is written

These are deliberately left unresolved here because they're easier to answer after Wave 1 ships and produces real usage data:

1. **CLIP embeddings — opt-in installer or core dependency?** Bundle weight is real. Probably an opt-in add-on, but the UX of "you need to install this to enable Color-by-Work" needs design.
2. **External knowledge lookup — which providers, which order, which fallback?** Wikidata is the broadest but slow; MAL is authoritative for anime; IMDB needs API key. The trade-offs become clearer after Wave 1 users report what kinds of Works they have most.
3. **Theme detection thresholds.** When does "a folder with many Works in it" become a Theme vs just a category folder? Empirical question; needs Wave-1 user-data signal.
4. **Manifestation-grouping conflict resolution.** If user has both `Beyblade (2001) [Eng Dub]` and `Beyblade Series Complete (English)`, are these the same Work or different? UX for ambiguity must be designed.
5. **Cleanup behavior for `depicts` files when a Work is archived.** Should consolidation cleanup *delete* depicting files, or just *suggest archive zone*? Probably the latter, but worth deciding explicitly.

---

## Summary

Wave 2 is the cognition-side complement to Wave 1's space-recovery mission. It populates dormant vocabulary (Work, Theme, manifestationOf, depicts, language) using a combination of dub-suffix rules, perceptual clustering, optional CLIP embeddings, filename heuristics, and opt-in external knowledge lookup. It adds three new user-facing surfaces (Consolidatable Manifestations cleanup section, cognition-side saved views, Color-by-Work treemap lens) on top of Wave 1's foundation, with no architectural rework.

The trigger to begin Wave 2 work: Wave 1 has shipped, users have generated enough Discovery confirmations to indicate the populator UX is healthy, and at least one Wave 2 saved view ("works I have multiple manifestations of") has a clear demand signal from real users.

The full Wave 2 spec will be authored when those conditions are met, with this document as its starting point.
