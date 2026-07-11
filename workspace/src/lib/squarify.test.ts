import { describe, expect, it } from "vitest";
import { squarify } from "./squarify";

describe("squarify", () => {
  it("tiles the box: rect areas sum to ~W*H and stay inside bounds", () => {
    const items = [5, 3, 2, 1, 1].map((v, i) => ({ ref: i, value: v }));
    const W = 636;
    const H = 572;
    const rects = squarify(items, 0, 0, W, H);
    expect(rects).toHaveLength(items.length);

    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(W * H, -1);

    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(-0.001);
      expect(r.y).toBeGreaterThanOrEqual(-0.001);
      expect(r.x + r.w).toBeLessThanOrEqual(W + 0.5);
      expect(r.y + r.h).toBeLessThanOrEqual(H + 0.5);
    }
  });

  it("drops zero/negative values and handles an empty box", () => {
    expect(squarify([{ ref: "a", value: 0 }], 0, 0, 100, 100)).toHaveLength(0);
    expect(squarify([{ ref: "a", value: 10 }], 0, 0, 0, 100)).toHaveLength(0);
  });
});
