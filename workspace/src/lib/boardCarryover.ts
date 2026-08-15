/**
 * One-shot rescue of anything a person typed on the old Findings canvas.
 *
 * That view kept three localStorage keys: card positions (`pos`), free notes
 * (`notes`) and per-card renames plus hand-drawn edge labels (`edits`). The
 * canvas is gone, so positions mean nothing and are dropped without ceremony.
 * The other two are **writing** — someone sat and typed them — and deleting
 * those silently because the feature moved is not a trade we get to make.
 *
 * So everything a person typed — free notes, card renames, and the labels on
 * edges they drew — is read once, shown once, and removed only when they say so.
 * They are shown, not migrated: there are no cards to rename and no edges to
 * redraw, so re-homing them would mean inventing a place to put them.
 */

const NOTES_KEY = (indexPath: string) => `be.board2.notes:${indexPath}`;
const EDITS_KEY = (indexPath: string) => `be.board2.edits:${indexPath}`;
const POS_KEY = (indexPath: string) => `be.board2.pos:${indexPath}`;

export type Carryover = { notes: string[]; names: string[]; edges: string[] };

function parse<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Anything worth showing, or null when there is nothing to carry over. */
export function readCarryover(indexPath: string): Carryover | null {
  const notesRaw = parse<Record<string, { text?: string }> | Array<{ text?: string }>>(
    NOTES_KEY(indexPath)
  );
  const editsRaw = parse<{
    overrides?: Record<string, { label?: string }>;
    edges?: Array<{ label?: string }>;
  }>(EDITS_KEY(indexPath));

  const notes = (notesRaw ? Object.values(notesRaw) : [])
    .map((n) => (n as { text?: string })?.text?.trim())
    .filter((t): t is string => !!t);

  const names = Object.values(editsRaw?.overrides ?? {})
    .map((o) => o?.label?.trim())
    .filter((t): t is string => !!t);

  // Edges someone drew and labelled by hand. These were being deleted without
  // ever being shown — the one thing this module exists to prevent.
  const edges = (editsRaw?.edges ?? [])
    .map((e) => e?.label?.trim())
    .filter((t): t is string => !!t);

  if (!notes.length && !names.length && !edges.length) {
    // Nothing written — the positions can go without asking.
    discardCarryover(indexPath);
    return null;
  }
  return { notes, names, edges };
}

/** Drop all three keys. Called once the person has seen what was in them. */
export function discardCarryover(indexPath: string) {
  try {
    localStorage.removeItem(NOTES_KEY(indexPath));
    localStorage.removeItem(EDITS_KEY(indexPath));
    localStorage.removeItem(POS_KEY(indexPath));
  } catch {
    /* private mode — nothing to clean up */
  }
}
