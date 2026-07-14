import { describe, expect, it } from "vitest";
import { formatAge } from "./domain";

describe("formatAge", () => {
  it("shows days under a year", () => {
    expect(formatAge(0)).toBe("today");
    expect(formatAge(5)).toBe("5d ago");
    expect(formatAge(364)).toBe("364d ago");
  });

  it("rolls a year or more into years + remaining days", () => {
    expect(formatAge(365)).toBe("1y ago");
    expect(formatAge(400)).toBe("1y 35d ago");
    // The DOS/FAT-epoch case from the field (mtime lost to 1980-01-01).
    expect(formatAge(16996)).toBe("46y 206d ago");
  });
});
