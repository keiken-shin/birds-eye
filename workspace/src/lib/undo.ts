/** Undoing a relocation is just moving every file back — no dedicated command. */
export function reversePairs(pairs: Array<{ from: string; to: string }>) {
  return pairs.map((pair) => ({ from: pair.to, to: pair.from }));
}
