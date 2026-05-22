// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { suggestKeep } from "../components/ComparisonPanel";
import type { NativeDuplicateFile } from "../nativeClient";

const file = (path: string, modified_at: number, size = 100): NativeDuplicateFile =>
  ({ path, size, modified_at, hash_state: 4 });

describe("suggestKeep", () => {
  it("returns empty string for empty input", () => {
    expect(suggestKeep([])).toBe("");
  });

  it("returns single file's path when only one file", () => {
    expect(suggestKeep([file("/a/doc.txt", 1000)])).toBe("/a/doc.txt");
  });

  it("prefers more recent file", () => {
    const older = file("/a/doc.txt", 1000);
    const newer = file("/b/doc.txt", 2000);
    expect(suggestKeep([older, newer])).toBe("/b/doc.txt");
  });

  it("deprioritizes files with SUSPECT segments", () => {
    const suspect = file("/backup/doc.txt", 2000);
    const clean = file("/docs/doc.txt", 1000);
    expect(suggestKeep([suspect, clean])).toBe("/docs/doc.txt");
  });

  it("deprioritizes year segments (2020-2029)", () => {
    const yearPath = file("/2023/doc.txt", 2000);
    const clean = file("/docs/doc.txt", 1000);
    expect(suggestKeep([yearPath, clean])).toBe("/docs/doc.txt");
  });

  it("prefers shallower path as tiebreak on equal modified_at", () => {
    const deep = file("/a/b/c/doc.txt", 1000);
    const shallow = file("/a/doc.txt", 1000);
    expect(suggestKeep([deep, shallow])).toBe("/a/doc.txt");
  });
});
