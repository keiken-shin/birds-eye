# Bird's Eye — the reimagined workspace (feat/reimagine)

The architecture study's synthesis ("one workspace · three lenses · a command spine") was already
implemented structurally — this pass rebuilds the *presentation layer* so the product actually
delivers it: visual-first, safe-feeling, and legible to a non-technical user.

## Navigation model

One persistent shell (title bar · command spine · rail · scope tree · stage · inspector · tray).
The **top bar** owns the stage-view switcher (icon segments, hover labels, keys 1–7) next to the
command input; the left rail is a slim **system dock** (New scan — the prominent verb — Scans &
queue, Library, Settings, all icon-only with hover labels). Scans is a full stage section of its
own: running scan, queue, and index management. Both side panels (scope tree, inspector) are
drag-resizable and collapsible (Ctrl+I toggles the inspector). Stage views — representation
switches, never page loads:

| # | View | What it is |
|---|------|------------|
| 1 | **Overview** | The hub. Capacity bar, stat tiles, category donut, top consumers, quick actions. Default view. |
| 2 | **Treemap** | The map. Verdict *or* category coloring, legend, small-item aggregation, drill animations. |
| 3 | **Board** | A true open canvas: stable card positions, typed cards with visuals, labeled edges, minimap, fit-to-view. |
| 4 | **Files** | Search + ranked results: category chips, size bars, sort by size/date, saved views, large-files preset. |
| 5 | **Duplicates** | Promoted from modal to view: group list with waste bars, thumbnail compare, keep-newest actions. |
| 6 | **Cleanup** | Risk-labeled recommendations (safe / review / caution) with multi-select → tray. |
| 7 | **Timeline** | Monthly activity chart, age distribution, staleness insights ("34% untouched 6+ months"). |

Scan / Scans / Library / Settings stay overlays over the shell. Inspector + Cleanup Tray persist
across every view; the only disk-mutating path remains Tray → Review gate → recycle bin.

## Visual language

- **Fonts**: Space Grotesk (UI/display) + JetBrains Mono (every number, path, size) — bundled via
  @fontsource, fully offline.
- **Color**: the hi-fi comp's near-black neutral ramp + spring-green accent, now *only* through
  tokens (no hardcoded literals). New **category palette** for the 9 media kinds — the second
  encoding channel next to the verdict palette (safe/review/protected/keep).
- **Icons**: lucide-react everywhere. No emoji, no unicode glyph soup.
- **Primitives** (`components/ui/`): Button, IconButton, Chip, Badge, Card, Overlay/Modal shell,
  SectionLabel, StatCard, EmptyState, MeterBar, Donut/Bars/Area charts (hand-rolled SVG).
- **Tone**: calm, quantified, anti-scareware. Every verdict pairs size + staleness + reason.
  Trust copy stays: "recycle bin first", "restorable 30 days", "never leaves your machine".

## Data

- Rust: `query_index` overview gains `timeline` (monthly modified-time buckets: files + bytes) and
  `age_buckets` (<1mo … 2yr+), and largest-files rows gain `modified_at`. One writer method + DTO
  fields — the SQLite schema already captured every timestamp.
- Frontend: browser dev-mode fixtures (`src/dev/`) implementing the native client surface so the
  whole workspace renders in plain vite — for design iteration and CI screenshots. Tauri builds
  are untouched.

## Why this shape (research-backed)

- Non-technical users trust **category language** (the phone/macOS storage bar), **age** ("haven't
  touched in a year"), and **explicit safety verdicts** — not file paths. Overview/Timeline/Cleanup
  speak those three languages.
- Treemaps win "spot the huge thing"; lists win comprehension — every view pairs a picture with a
  plain list. Spatial memory needs **stable layouts** (fixed board positions, stable treemap order).
- Reversibility beats confirmation dialogs: staging tray + review gate + undo toast + Library
  restore already existed — now the UI states it loudly.
