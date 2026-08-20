# Store and listing copy

Every user-facing string that lives outside the app and outside this site — store fields,
repository metadata, the sentence you say at a meetup. They live here so they're in the repo
and versioned, instead of only in whoever's browser tab. **Copy from this page; don't rewrite
from memory.** These strings are the positioning, and they only work if they're identical
everywhere.

Two rules that apply to all of them:

- **Always pair the name with the noun** — *"Bird's Eye — disk cleanup for Windows"* — in every
  title, description and bio field. The name is memorable but it doesn't say what the product
  is, and search engines and humans both need the noun.
- **Run every edit through the test:** would you say this sentence out loud to a friend? The
  full voice rules and the say-this-not-that table are in [Brand](../brand.md).

## The one-liner

For when someone asks what you built.

```text
It's a disk cleanup tool for Windows that actually explains itself — it tells
you what's safe to delete and why, instead of just showing you a treemap and
wishing you luck.
```

## Microsoft Store — short description

The eight-second decision, and the highest-leverage sentence we have. **142 characters**
(Partner Center allows 1,000).

```text
Find what's safe to delete on your PC — with a reason for every
recommendation. Free, offline, and everything goes to the Recycle Bin first.
```

## Microsoft Store — long description

```text
Your drive is full. The usual tools draw you a colourful map of what's
big — and leave you to guess what's safe to remove.

Bird's Eye goes one step further. It scans your folders, works out what
each one actually is — a build cache, an installer you already ran, a
duplicate download, a project you finished two years ago — and tells you
which ones you can safely delete, how much space you'd get back, and why.

Every recommendation shows three things: the size, how long it's sat
untouched, and a plain-English reason. Nothing is deleted until you
review a list of exactly what will happen. Everything goes to the
Recycle Bin, restorable for 30 days.

And nothing ever leaves your PC. No account, no sign-in, no telemetry,
no upload — not a filename, not a hash. It works with the network off.
The source is public and MIT-licensed, so you can check rather than
take our word for it.

WHAT IT FINDS
• Build outputs and package caches — node_modules, target, .gradle, pip
• Installers you already ran, sitting in Downloads
• Duplicate files, ranked by how much space they waste
• Projects you finished and haven't opened in a year
• Old backups, VM disks and model files you forgot about

WHAT IT WILL NEVER DO
• No "health score." No "247 issues found."
• No registry cleaning. No startup "optimisation."
• No nagging, no countdowns, no upsell.
• No account, and no data leaving your machine.
```

## GitHub — About field

**289 characters**, against the 350-character limit.

```text
Free, offline disk cleanup for Windows that tells you what's safe to
delete and why — not just what's big. Build caches, old installers,
duplicates and stale projects, each with a size, an age and a reason.
Recycle Bin first, restorable 30 days. No account, no telemetry. Rust
+ Tauri.
```

!!! note "One word to watch"
    "Stale projects" is the only place the word *stale* survives, and only because this field
    has to fit 350 characters. Everywhere with room, give the number instead — *"untouched 8
    months," "projects you finished and haven't opened in a year."* The number is the argument.
    A within-limit alternative if you'd rather not ship it: *"…duplicates and projects you
    finished years ago…"* (306 characters).

## Website hero

Shipped on the [documentation home page](../index.md). Repeated here so the whole set is in
one place.

```text
See what you can delete. Know why it's safe.

Bird's Eye is a free, offline disk cleanup tool for Windows. It turns a
drive scan into specific decisions: the size, when you last touched it,
and the reason it can—or cannot—go.

Recycle Bin first. Review every change. 0 bytes uploaded.

[ Get it from the Microsoft Store ]  [ Download the portable .exe ]

Free · MIT · Windows 10 & 11 · ~14 MB · works offline
```

Immediately below the fold:

```text
A disk map answers "where did my space go?"
Bird's Eye answers the question that actually unblocks you:
"which of this can I delete, and how do you know?"

node_modules · 12.3 GB · untouched 8 months · a build cache that fills
itself back in when needed. That's a decision you can inspect.
```

## Site metadata

The site title and description, for whichever generator builds this site:

```text
title:       Bird's Eye — disk cleanup for Windows
description: Free, offline disk cleanup for Windows that explains what is safe
             to remove, lets you stage a decision, and reviews every change
             before it reaches your drive.
```

## The answer to "isn't WizTree faster?"

It will come up, because a developer will run both. Never claim to be fastest, never bury the
question, never pick a fight — WizTree is a good tool and its users will defend it. The line,
verbatim:

> The first scan takes a few minutes, because it's reading more than sizes. After that it only
> looks at what changed — so the second scan is seconds.

## Where else these strings appear

Update all of them together, or they drift:

| Surface | What to paste |
|---|---|
| Microsoft Store listing | Short description, long description |
| GitHub repository About | About field |
| `README.md` | The three opening paragraphs, "What it finds", "What it will never do" |
| Documentation home | Website hero, the manifesto below the fold |
| Site config | Site metadata title and description |
| Directory listings (AlternativeTo, Softpedia, MajorGeeks, FossHub) | The one-liner, then the Store short description |
| winget / Chocolatey / Scoop manifests | The one-liner as `ShortDescription` |
