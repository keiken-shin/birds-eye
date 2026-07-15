# Brand

Bird's Eye looks and sounds like the thing it is: a calm, precise instrument for your own
machine. Dark like the app, quantified like the data, and never alarmist. This page is the
reference for anyone building UI, docs, or marketing around it.

## The mark

The logo is a single-stroke **bird** in spring green on a near-black tile — a lucide-family
glyph, drawn with rounded joins.

<img src="assets/icon.png" alt="Bird's Eye app icon" width="112" style="border-radius:22px" />

- Use the green bird on a dark surface. Keep clear space around it equal to the width of
  its shortest stroke.
- Don't recolor it, add gradients, rotate it, or place it on a busy background.
- The favicon and in-app mark are the same glyph — one bird, everywhere.

## Color

A near-black neutral ramp carries the interface; a single **spring green** is the only
brand accent. Meaning is layered on with two small, fixed palettes — one for **verdicts**,
one for **media categories**. Everything comes from tokens in `workspace/src/index.css` —
never hardcode a literal.

### Core

<div style="display:flex;flex-wrap:wrap;gap:10px;margin:1rem 0">
  <span style="display:inline-flex;align-items:center;gap:8px"><span style="width:22px;height:22px;border-radius:5px;background:#0a0b0d;border:1px solid #1e2128"></span><code>#0a0b0d</code> base</span>
  <span style="display:inline-flex;align-items:center;gap:8px"><span style="width:22px;height:22px;border-radius:5px;background:#0e1014;border:1px solid #1e2128"></span><code>#0e1014</code> window</span>
  <span style="display:inline-flex;align-items:center;gap:8px"><span style="width:22px;height:22px;border-radius:5px;background:#191c22;border:1px solid #1e2128"></span><code>#191c22</code> raised</span>
  <span style="display:inline-flex;align-items:center;gap:8px"><span style="width:22px;height:22px;border-radius:5px;background:#3ddc84"></span><code>#3ddc84</code> primary</span>
  <span style="display:inline-flex;align-items:center;gap:8px"><span style="width:22px;height:22px;border-radius:5px;background:#e6e8ea"></span><code>#e6e8ea</code> ink</span>
  <span style="display:inline-flex;align-items:center;gap:8px"><span style="width:22px;height:22px;border-radius:5px;background:#9aa0a8"></span><code>#9aa0a8</code> muted</span>
</div>

The spring green (`--color-primary: #3ddc84`) is used sparingly — for the primary verb,
active state, and links. On green, text is near-black (`#06140c`). Over-using the accent
kills its meaning; when everything is green, nothing is.

### Verdicts

The safety language, always paired with a size and a reason:

<p style="display:flex;flex-wrap:wrap;gap:8px;margin:0.75rem 0">
  <span class="be-chip be-chip--safe">safe</span>
  <span class="be-chip be-chip--review">review</span>
  <span class="be-chip be-chip--protected">protected</span>
  <span class="be-chip be-chip--keep">keep</span>
</p>

### Media categories

Nine kinds, each with its own hue — the second encoding channel next to verdicts:

<div style="display:flex;flex-wrap:wrap;gap:10px;margin:0.75rem 0;font-size:0.85em">
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#d1651f"></span>video</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#22a3c9"></span>photo</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#d15590"></span>music</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#bd8813"></span>document</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#4b82e8"></span>code</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#9177ee"></span>archive</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#7f8c1a"></span>model</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#d0544a"></span>installer</span>
  <span style="display:inline-flex;align-items:center;gap:6px"><span style="width:14px;height:14px;border-radius:4px;background:#5f6672"></span>other</span>
</div>

## Typography

Two typefaces, both bundled via `@fontsource` so the app is fully offline.

- **Space Grotesk** — UI and display. Headings, labels, body.
- **JetBrains Mono** — every **number, path, and size**. If it's data, it's monospace.

That split is a rule, not a suggestion: quantities in mono make the interface read as
measured and trustworthy.

## Iconography

**lucide** icons, everywhere. No emoji, no unicode glyph soup, no mixed icon sets. The bird
mark itself is from the same family.

## Voice & tone

Calm, quantified, and **anti-scareware**. Bird's Eye is an analyst, not a salesperson.

- **Quantify everything.** Every verdict pairs a **size** + **staleness** + **reason**.
  Never "clean up junk" — always "12.4 GB of build cache, untouched 8 months."
- **Never manufacture urgency.** No countdowns, no red badges screaming for attention, no
  "your PC is at risk." The data is the argument.
- **Keep the trust copy.** These lines earn their place on screen: *“recycle bin first,”*
  *“restorable 30 days,”* *“never leaves your machine.”*
- **Say what you don't know.** *Unclassified* is an honest answer. Don't invent a purpose
  or a confidence the app doesn't have.

When in doubt, write it the way you'd want a careful colleague to explain what's about to
happen to your files.
