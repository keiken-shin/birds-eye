import { describe, expect, it } from "vitest";
import { VERDICT_LEGEND, VERDICT_STYLES, canStage, explainFolder, verdictForFolder } from "./verdict";

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

describe("verdict labels", () => {
  it("shows three labels, never four", () => {
    const labels = new Set(Object.values(VERDICT_STYLES).map((s) => s.label));
    expect([...labels].sort()).toEqual(["Check first", "Don't touch", "Safe to delete"]);
    expect(VERDICT_LEGEND).toHaveLength(3);
    expect(VERDICT_LEGEND.map((v) => VERDICT_STYLES[v].label)).toEqual([
      "Safe to delete",
      "Check first",
      "Don't touch",
    ]);
  });

  // The whole point of merging four states into three labels: a user reads one
  // word, the safety rules keep their four-way behaviour underneath it.
  it("gives protected and keep the same label but not the same stageability", () => {
    expect(VERDICT_STYLES.protected.label).toBe(VERDICT_STYLES.keep.label);
    expect(canStage("protected", 999)).toBe(false);
    expect(canStage("keep", 999)).toBe(true);
  });

  it("renders protected and keep identically", () => {
    expect(VERDICT_STYLES.protected).toEqual(VERDICT_STYLES.keep);
  });
});

describe("explainFolder", () => {
  it("says it out loud instead of quoting the taxonomy", () => {
    expect(explainFolder(row({ role: "scratch", replaceability: "regenerable" }))).toBe(
      "A build cache · it fills itself back in when it's needed."
    );
    expect(explainFolder(row({ role: "backup" }))).toBe("A backup copy.");
  });

  // A backup is "regenerable" because another copy survives, never because you could
  // recreate it. Telling someone they can rebuild a backup is how you lose their only copy.
  it("never tells you a backup is rebuildable", () => {
    const backup = explainFolder(row({ role: "backup", replaceability: "regenerable" }));
    expect(backup).toBe("A backup copy · there's another copy of it.");
    expect(backup).not.toMatch(/rebuild|build it again/);

    const sole = explainFolder(row({ role: "backup", replaceability: "irreplaceable" }));
    expect(sole).toBe("A backup copy · there's no other copy of it.");
    expect(sole).not.toMatch(/rebuild/);
  });

  it("admits it doesn't know rather than inventing a reason", () => {
    expect(explainFolder(row())).toBe("Bird's Eye hasn't worked out what this folder is yet.");
  });
});
