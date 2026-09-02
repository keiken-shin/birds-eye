import { describe, expect, it } from "vitest";
import { duplicateEvidence, readShareLabel, splitByEvidence } from "./evidence";

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

describe("readShareLabel", () => {
  it("says 100% only when nothing was skipped", () => {
    expect(readShareLabel(50_000, 0)).toBe("100%");
  });

  it("never rounds a near miss up to 100%", () => {
    // 49,999 of 50,000 is 99.998%. Reporting that as 100% hides a real file.
    expect(readShareLabel(49_999, 1)).toBe("99.9%");
  });

  it("rounds down, never up", () => {
    expect(readShareLabel(899, 101)).toBe("89.9%");
  });

  it("has no percentage when nothing needed reading", () => {
    expect(readShareLabel(0, 0)).toBeNull();
  });

  it("reports a total failure as 0%", () => {
    expect(readShareLabel(0, 40)).toBe("0.0%");
  });
});
