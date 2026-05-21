import { describe, it, expect } from "vitest";
import { defaultScanStrategy, parseScanStrategy } from "../domain";

describe("ScanStrategy helpers", () => {
  it("default is smart", () => {
    expect(defaultScanStrategy).toBe("smart");
  });

  it("parses smart", () => {
    expect(parseScanStrategy("smart")).toBe("smart");
  });

  it("parses metadata", () => {
    expect(parseScanStrategy("metadata")).toBe("metadata");
  });

  it("falls back to smart for unknown values", () => {
    expect(parseScanStrategy("xxh3-progressive")).toBe("smart");
    expect(parseScanStrategy(null)).toBe("smart");
    expect(parseScanStrategy(undefined)).toBe("smart");
  });
});
