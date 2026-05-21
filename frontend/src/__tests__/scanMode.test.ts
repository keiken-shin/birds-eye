import { describe, it, expect } from "vitest";
import { defaultScanStrategy, parseScanStrategy } from "../domain";

describe("parseScanStrategy", () => {
  it("returns smart for the default", () => {
    expect(defaultScanStrategy).toBe("smart");
  });

  it("returns metadata for the metadata string", () => {
    expect(parseScanStrategy("metadata")).toBe("metadata");
  });

  it("falls back to smart for unknown values", () => {
    expect(parseScanStrategy("xxh3-progressive")).toBe("smart");
    expect(parseScanStrategy(null)).toBe("smart");
    expect(parseScanStrategy(undefined)).toBe("smart");
  });
});
