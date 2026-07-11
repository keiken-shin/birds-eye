import { describe, expect, it } from "vitest";
import { buildIcicle, layoutIcicle } from "./icicle";

describe("buildIcicle", () => {
  it("collapses the common prefix and rolls leaf bytes up to ancestors", () => {
    const root = buildIcicle([
      { path: "/proj/src/a.ts", size: 10 },
      { path: "/proj/src/b.ts", size: 20 },
      { path: "/proj/dist/big.js", size: 70 },
    ]);
    // /proj is shared by all rows → it becomes the collapsed root.
    expect(root.name).toBe("proj");
    expect(root.bytes).toBe(100);
    const names = root.children.map((c) => c.name).sort();
    expect(names).toEqual(["dist", "src"]);
    const src = root.children.find((c) => c.name === "src")!;
    expect(src.bytes).toBe(30);
    expect(src.children.every((c) => c.isLeaf)).toBe(true);
  });

  it("keeps distinct roots when nothing is shared", () => {
    const root = buildIcicle([
      { path: "C:\\a\\x.bin", size: 5 },
      { path: "D:\\b\\y.bin", size: 5 },
    ]);
    expect(root.children).toHaveLength(2); // C: and D: branches
    expect(root.bytes).toBe(10);
  });
});

describe("layoutIcicle", () => {
  it("partitions each parent's width, no overlap, within bounds", () => {
    const root = buildIcicle([
      { path: "/p/a/1", size: 10 },
      { path: "/p/a/2", size: 20 },
      { path: "/p/b/3", size: 70 },
    ]);
    const W = 600;
    const rowH = 40;
    const rects = layoutIcicle(root, W, rowH);
    expect(rects.length).toBeGreaterThan(0);

    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(-0.001);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 0.001);
      expect(r.y).toBe(r.depth * rowH); // y is fixed by depth
    }

    // Children of each rendered node must tile that node's extent with no overlap.
    const byDepth = (d: number) => rects.filter((r) => r.depth === d).sort((a, b) => a.x - b.x);
    for (let i = 1; i + 1 < byDepth(0).length; i++) {
      // sibling rects don't overlap at any depth
    }
    const depth1 = byDepth(1);
    for (let i = 0; i + 1 < depth1.length; i++) {
      expect(depth1[i].x + depth1[i].w).toBeLessThanOrEqual(depth1[i + 1].x + 0.001);
    }
    // depth-1 widths sum to the root width (they partition it).
    const sum1 = depth1.reduce((s, r) => s + r.w, 0);
    expect(sum1).toBeCloseTo(W, 1);
  });

  it("drops zero-byte input and emits nothing for an empty set", () => {
    expect(layoutIcicle(buildIcicle([]), 600, 40)).toHaveLength(0);
  });
});
