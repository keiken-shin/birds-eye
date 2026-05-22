import { describe, it, expect } from "vitest";
import { truncatePath } from "../utils/pathUtils";

describe("truncatePath", () => {
  it("returns path unchanged when short enough", () => {
    expect(truncatePath("D:\\Photos\\img.jpg")).toBe("D:\\Photos\\img.jpg");
  });

  it("compresses deep Windows path keeping root and last 2 segments", () => {
    const input = "D:\\Co-HDD\\Stream\\sitcom\\How I Met Your Mother (2005)\\s01e01.mkv";
    expect(truncatePath(input)).toBe("D:\\...\\How I Met Your Mother (2005)\\s01e01.mkv");
  });

  it("compresses a deep Unix path", () => {
    const input = "/home/user/documents/deeply/nested/file.txt";
    expect(truncatePath(input)).toBe("/.../nested/file.txt");
  });

  it("respects a custom keepSegments argument", () => {
    expect(truncatePath("D:\\a\\b\\c\\d\\e.txt", 3)).toBe("D:\\...\\c\\d\\e.txt");
  });

  it("returns path unchanged when already short", () => {
    expect(truncatePath("D:\\a\\b.txt")).toBe("D:\\a\\b.txt");
  });

  it("clamps keepSegments=0 to 1 to prevent garbage output", () => {
    const path = "D:\\a\\b\\c\\d\\e.txt";
    expect(truncatePath(path, 0)).toBe(truncatePath(path, 1));
  });

  it("normalizes mixed separators in paths before splitting", () => {
    const mixed = "D:\\a/b/c/d/e.txt";
    const consistent = "D:\\a\\b\\c\\d\\e.txt";
    expect(truncatePath(mixed)).toBe(truncatePath(consistent));
  });
});
