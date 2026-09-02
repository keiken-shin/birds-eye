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
