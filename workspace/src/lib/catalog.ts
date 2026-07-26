import type { NativeDiscovery, NativeRelocationPayload } from "@bridge/nativeClient";

export type RelocationCard = {
  id: number;
  confidence: number;
  payload: NativeRelocationPayload;
};

/** A row whose payload will not parse is dropped, never rendered half-built. */
export function parseCards(rows: NativeDiscovery[]): RelocationCard[] {
  const cards: RelocationCard[] = [];
  for (const row of rows) {
    try {
      cards.push({
        id: row.id,
        confidence: row.confidence,
        payload: JSON.parse(row.payload) as NativeRelocationPayload,
      });
    } catch {
      // Unparseable payload — skip it rather than break the view.
    }
  }
  return cards;
}

/** Impact (how many files, how many bytes) discounted by how sure we are. */
function score(card: RelocationCard) {
  return card.payload.member_count * card.payload.total_bytes * card.confidence;
}

export function rankCards(cards: RelocationCard[]): RelocationCard[] {
  return cards.slice().sort((a, b) => score(b) - score(a));
}

export function sourceLabel(source: string) {
  switch (source) {
    case "rule":
      return "Your rule";
    case "learned":
      return "Learned";
    case "template":
      return "Convention";
    default:
      return "Suggested";
  }
}

/** Join a destination folder and a filename using the folder's own separator. */
export function destinationFor(destination: string, name: string) {
  const sep = destination.includes("/") && !destination.includes("\\") ? "/" : "\\";
  return destination.replace(/[\\/]+$/, "") + sep + name;
}
