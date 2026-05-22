import { describe, expect, it } from "vitest";
import { computeSmartMoves, suggestKeep, groupByParentFolder } from "../utils/smartMoves";
import type { NativeDuplicateFile } from "../nativeClient";

const f = (path: string, modified_at: number | null): NativeDuplicateFile =>
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

  it("treats null modified_at as epoch 0 (oldest) in recency tiebreak", () => {
    // /a has null modified_at, /b has 5000, /c has 100
    // /b should win on recency; /a and /c are outliers
    const files = [
      f("/a/x.jpg", null),
      f("/b/x.jpg", 5000),
      f("/c/x.jpg", 100),
    ];
    const result = computeSmartMoves(files);
    expect(result).toHaveLength(1);
    expect(result[0].targetFolder).toBe("/b");
    expect(result[0].filesToMove).toEqual(
      expect.arrayContaining(["/a/x.jpg", "/c/x.jpg"])
    );
  });

  it("reason string mentions counts", () => {
    const files = [
      f("/docs/a.jpg", 3000),
      f("/docs/b.jpg", 2000),
      f("/backup/a.jpg", 1000),
      f("/archive/a.jpg", 500),
    ];
    const [move] = computeSmartMoves(files);
    expect(move.reason).toMatch(/\b2\b/);   // dominant count
    expect(move.reason).toMatch(/\b4\b/);   // total count
  });
});

describe("suggestKeep", () => {
  const f = (path: string, modified_at: number | null) =>
    ({ path, size: 100, modified_at, hash_state: 4 as const });

  it("returns empty string for empty input", () => {
    expect(suggestKeep([])).toBe("");
  });

  it("prefers file without suspect keywords", () => {
    const files = [f("/backup/img.jpg", 2000), f("/photos/img.jpg", 1000)];
    expect(suggestKeep(files)).toBe("/photos/img.jpg");
  });

  it("breaks suspect tie by most recently modified", () => {
    const files = [f("/a/img.jpg", 1000), f("/b/img.jpg", 5000)];
    expect(suggestKeep(files)).toBe("/b/img.jpg");
  });

  it("breaks recency tie by shallowest path", () => {
    const files = [f("/a/b/c/img.jpg", 1000), f("/x/img.jpg", 1000)];
    expect(suggestKeep(files)).toBe("/x/img.jpg");
  });
});

describe("groupByParentFolder", () => {
  const f = (path: string, modified_at: number | null, size = 500) =>
    ({ path, size, modified_at, hash_state: 4 as const });

  it("returns [] for empty input", () => {
    expect(groupByParentFolder([])).toEqual([]);
  });

  it("returns [] when all files share the same parent", () => {
    const files = [f("/photos/a.jpg", 1000), f("/photos/b.jpg", 2000)];
    expect(groupByParentFolder(files)).toEqual([]);
  });

  it("returns a FolderMove when files split across two folders", () => {
    const files = [
      f("/photos/a.jpg", 2000),
      f("/photos/b.jpg", 1500),
      f("/backup/a.jpg", 1000),
      f("/backup/b.jpg", 500),
    ];
    const result = groupByParentFolder(files);
    expect(result).toHaveLength(1);
    expect(result[0].keepFolder).toBe("/photos");
    expect(result[0].stageFolder).toBe("/backup");
    expect(result[0].fileCount).toBe(2);
    expect(result[0].reclaimableBytes).toBe(1000);
  });

  it("uses suggestKeep heuristic — prefers non-suspect folder", () => {
    const files = [f("/backup/a.jpg", 2000), f("/photos/a.jpg", 1000)];
    const result = groupByParentFolder(files);
    expect(result).toHaveLength(1);
    expect(result[0].keepFolder).toBe("/photos");
  });

  it("returns [] when only one file per folder", () => {
    const files = [f("/a/x.jpg", 1000), f("/b/y.jpg", 2000)];
    expect(groupByParentFolder(files)).toEqual([]);
  });
});
