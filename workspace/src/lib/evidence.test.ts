import { describe, expect, it } from "vitest";
import { readShareLabel, splitByEvidence } from "./evidence";

// The band itself is decided in the index and covered by its own tests there
// (src/index/evidence.rs). What this file owns is what the workspace does with
// the name once it arrives.

describe("splitByEvidence", () => {
  it("keeps byte-identical bytes apart from sampled bytes", () => {
    const split = splitByEvidence([
      { reclaimable_bytes: 4_000, evidence: "exact" },
      { reclaimable_bytes: 40_000_000_000, evidence: "sampled" },
      { reclaimable_bytes: 900, evidence: "size-only" },
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
