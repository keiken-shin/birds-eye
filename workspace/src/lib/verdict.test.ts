import { describe, expect, it } from "vitest";
import { canStage, verdictForFolder } from "./verdict";

const row = (over: Partial<Parameters<typeof verdictForFolder>[0]> = {}) => ({
  role: null,
  replaceability: null,
  lifecycle: null,
  cleanup_reason: null,
  reclaimable_bytes: 0,
  ...over,
});

describe("verdictForFolder", () => {
  it("maps each safe cleanup_reason to safe", () => {
    for (const r of ["safe-derivative", "redundant-backup", "scratch"]) {
      expect(verdictForFolder(row({ cleanup_reason: r, reclaimable_bytes: 100 }))).toBe("safe");
    }
  });

  it("maps finished-project-cruft to review", () => {
    expect(verdictForFolder(row({ cleanup_reason: "finished-project-cruft" }))).toBe("review");
  });

  it("treats irreplaceable / active / protected roles as protected", () => {
    expect(verdictForFolder(row({ replaceability: "irreplaceable" }))).toBe("protected");
    expect(verdictForFolder(row({ lifecycle: "active" }))).toBe("protected");
    expect(verdictForFolder(row({ role: "source" }))).toBe("protected");
    expect(verdictForFolder(row({ role: "system" }))).toBe("protected");
  });

  it("protected wins even if a cleanup_reason is somehow present", () => {
    expect(
      verdictForFolder(row({ replaceability: "irreplaceable", cleanup_reason: "scratch" }))
    ).toBe("protected");
  });

  it("falls back to keep when nothing is reclaimable", () => {
    expect(verdictForFolder(row())).toBe("keep");
  });

  it("never lets protected folders be staged", () => {
    expect(canStage("protected", 999)).toBe(false);
    expect(canStage("safe", 100)).toBe(true);
    expect(canStage("keep", 0)).toBe(false);
  });
});
