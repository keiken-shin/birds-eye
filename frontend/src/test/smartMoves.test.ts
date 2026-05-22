// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { computeSmartMoves } from "../utils/smartMoves";
import type { NativeDuplicateFile } from "../nativeClient";

const f = (path: string, modified_at: number): NativeDuplicateFile =>
  ({ path, size: 100, modified_at, hash_state: 4 });

describe("computeSmartMoves", () => {
  it("returns [] for empty input", () => {
    expect(computeSmartMoves([])).toEqual([]);
  });

  it("returns [] when all files are in the same folder", () => {
    const files = [f("/docs/a.jpg", 1000), f("/docs/b.jpg", 2000)];
    expect(computeSmartMoves(files)).toEqual([]);
  });

  it("returns [] when there is only 1 outlier file (threshold < 2)", () => {
    // 2 files: 1 in /docs, 1 in /backup — only 1 outlier, no suggestion
    const files = [f("/docs/a.jpg", 2000), f("/backup/a.jpg", 1000)];
    expect(computeSmartMoves(files)).toEqual([]);
  });

  it("suggests dominant folder as target when 2+ outliers exist", () => {
    const files = [
      f("/docs/a.jpg", 3000),
      f("/docs/b.jpg", 2000),
      f("/backup/a.jpg", 1000),
      f("/archive/a.jpg", 500),
    ];
    const result = computeSmartMoves(files);
    expect(result).toHaveLength(1);
    expect(result[0].targetFolder).toBe("/docs");
    expect(result[0].filesToMove).toEqual(
      expect.arrayContaining(["/backup/a.jpg", "/archive/a.jpg"])
    );
    expect(result[0].filesToMove).toHaveLength(2);
  });

  it("breaks tie by most recently modified file in folder", () => {
    // /a has 1 file (modified 9000), /b has 1 file (modified 100)
    // but we need 2+ outliers — add a third folder
    const files = [
      f("/a/x.jpg", 9000),
      f("/b/x.jpg", 100),
      f("/c/x.jpg", 50),
    ];
    const result = computeSmartMoves(files);
    // /a wins on recency; /b and /c are outliers (2 total → suggestion emitted)
    expect(result).toHaveLength(1);
    expect(result[0].targetFolder).toBe("/a");
    expect(result[0].filesToMove).toEqual(
      expect.arrayContaining(["/b/x.jpg", "/c/x.jpg"])
    );
  });

  it("breaks further tie by shallowest folder depth", () => {
    // /a/b/c (depth 3) vs /x (depth 1), equal count and equal recency
    // need 2+ outliers so add a third
    const files = [
      f("/a/b/c/x.jpg", 1000),
      f("/x/x.jpg", 1000),
      f("/y/x.jpg", 999),
    ];
    const result = computeSmartMoves(files);
    // /x wins on depth; /a/b/c and /y are outliers
    expect(result).toHaveLength(1);
    expect(result[0].targetFolder).toBe("/x");
  });

  it("reason string mentions counts", () => {
    const files = [
      f("/docs/a.jpg", 3000),
      f("/docs/b.jpg", 2000),
      f("/backup/a.jpg", 1000),
      f("/archive/a.jpg", 500),
    ];
    const [move] = computeSmartMoves(files);
    expect(move.reason).toContain("2");   // dominant count
    expect(move.reason).toContain("4");   // total count
  });
});
