import { describe, expect, it } from "vitest";
import { ageDays, formatAge, MIN_REAL_MTIME } from "./domain";

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

describe("ageDays", () => {
  const now = 1_800_000_000; // fixed "now" for deterministic days

  it("returns whole days for a real timestamp", () => {
    expect(ageDays(now - 5 * 86_400, now)).toBe(5);
    expect(ageDays(now, now)).toBe(0);
  });

  it("returns null for a missing timestamp", () => {
    expect(ageDays(null, now)).toBeNull();
  });

  it("returns null for a reset/pre-1990 timestamp (1980 FAT epoch)", () => {
    expect(ageDays(315_513_000, now)).toBeNull(); // 1980-01-01
    expect(ageDays(MIN_REAL_MTIME - 1, now)).toBeNull();
    expect(ageDays(MIN_REAL_MTIME, now)).not.toBeNull(); // exactly the floor is trusted
  });
});
