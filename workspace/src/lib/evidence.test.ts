import { describe, expect, it } from "vitest";
import { duplicateEvidence, splitByEvidence } from "./evidence";

describe("duplicateEvidence", () => {
  it("names the three bands the index actually produces", () => {
    // 1.0 / 0.80 / 0.60 are what rebuild_duplicate_size_groups assigns.
    expect(duplicateEvidence(1.0)).toBe("exact");
    expect(duplicateEvidence(0.8)).toBe("sampled");
    expect(duplicateEvidence(0.6)).toBe("size-only");
  });

  it("does not round a sampled group up to exact", () => {
    expect(duplicateEvidence(0.98)).toBe("sampled");
  });
});

describe("splitByEvidence", () => {
  it("keeps byte-identical bytes apart from sampled bytes", () => {
    const split = splitByEvidence([
      { reclaimable_bytes: 4_000, confidence: 1.0 },
      { reclaimable_bytes: 40_000_000_000, confidence: 0.8 },
      { reclaimable_bytes: 900, confidence: 0.6 },
    ]);
    expect(split).toEqual({ exact: 4_000, sampled: 40_000_000_000, "size-only": 900 });
  });

  it("is zero everywhere for no groups", () => {
    expect(splitByEvidence([])).toEqual({ exact: 0, sampled: 0, "size-only": 0 });
  });
});
