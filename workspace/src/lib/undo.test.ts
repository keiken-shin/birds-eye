import { describe, expect, it } from "vitest";
import { reversePairs } from "./undo";

describe("reversePairs", () => {
  it("swaps from and to so a move can be undone by move_files", () => {
    expect(
      reversePairs([
        { from: "C:\\Inbox\\a.exe", to: "D:\\Software\\a.exe" },
        { from: "C:\\Inbox\\b.exe", to: "D:\\Software\\b.exe" },
      ])
    ).toEqual([
      { from: "D:\\Software\\a.exe", to: "C:\\Inbox\\a.exe" },
      { from: "D:\\Software\\b.exe", to: "C:\\Inbox\\b.exe" },
    ]);
  });

  it("is its own inverse", () => {
    const pairs = [{ from: "a", to: "b" }];
    expect(reversePairs(reversePairs(pairs))).toEqual(pairs);
  });

  it("handles an empty result", () => {
    expect(reversePairs([])).toEqual([]);
  });
});
