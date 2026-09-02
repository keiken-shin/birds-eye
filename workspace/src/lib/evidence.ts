/**
 * How good is the evidence behind a claim?
 *
 * One definition, because the app makes this distinction in several places and
 * they must agree. A duplicate group is only "exact" when every member carries a
 * complete-content digest. Anything else matched on sampled parts of the file,
 * or on size alone, and saying so is the difference between a finding and a
 * promise.
 *
 * Files above the eager hashing cap can only reach "sampled" during a scan. They
 * are read in full at the moment of deletion instead, so a sampled group is
 * worth showing -- it is just not worth summing into the same number as an exact
 * one.
 */

export type Evidence = "exact" | "sampled" | "size-only";

/** Mirrors the confidence the duplicate-group builder assigns in the index. */
export function duplicateEvidence(confidence: number): Evidence {
  if (confidence >= 0.99) return "exact";
  if (confidence >= 0.8) return "sampled";
  return "size-only";
}

export const EVIDENCE_LABEL: Record<Evidence, string> = {
  exact: "EXACT COPY",
  sampled: "SAMPLED",
  "size-only": "SIZE MATCH",
};

type WithEvidence = { reclaimable_bytes: number; confidence: number };

/**
 * Splits a set of duplicate groups by evidence strength. Callers show the parts,
 * never a single total: 4 GB of byte-identical copies and 4 GB that agreed on a
 * few hundred kilobytes are not the same claim.
 */
export function splitByEvidence(groups: readonly WithEvidence[]): Record<Evidence, number> {
  const out: Record<Evidence, number> = { exact: 0, sampled: 0, "size-only": 0 };
  for (const group of groups) {
    out[duplicateEvidence(group.confidence)] += group.reclaimable_bytes;
  }
  return out;
}

/**
 * How much of what needed reading was read, as a label.
 *
 * Rounding must never manufacture completeness. 99.98% read is not 100% read,
 * and someone deciding what to delete is entitled to know a file was missed, so
 * "100%" appears only when nothing at all was skipped and every other value
 * rounds down.
 *
 * `null` when nothing needed reading: there is no honest percentage over an
 * empty denominator, and "100%" would be the most confident possible way of
 * saying nothing.
 */
export function readShareLabel(read: number, skipped: number): string | null {
  const attempted = read + skipped;
  if (attempted <= 0) return null;
  if (skipped === 0) return "100%";
  const share = read / attempted;
  return `${Math.min(99.9, Math.floor(share * 1000) / 10).toFixed(1)}%`;
}
