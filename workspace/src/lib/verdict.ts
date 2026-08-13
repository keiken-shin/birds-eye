import type { Verdict } from "../state/types";
import type { NativeTreemapLensFolder } from "@bridge/nativeClient";

/**
 * Folder-level verdict derived from the REAL backend taxonomy
 * (src/index/schema.rs cleanup view + src/native/api.rs treemap_lens_data rollups).
 *
 * treemap_lens_data gives dominant {role, replaceability, lifecycle, cleanup_reason,
 * reclaimable_bytes} per folder. Sensitivity / is_pinned are per-file and not rolled up
 * here, so the folder mapping uses the fields available — which is the honest granularity.
 */
const SAFE_REASONS = new Set(["safe-derivative", "redundant-backup", "scratch"]);
const PROTECTED_ROLES = new Set(["source", "system", "asset", "tool"]);

export function verdictForFolder(row: Pick<
  NativeTreemapLensFolder,
  "role" | "replaceability" | "lifecycle" | "cleanup_reason" | "reclaimable_bytes"
>): Verdict {
  // Hard-excluded → protected (never auto-staged), matching the schema's hard_excluded CTE.
  if (
    row.replaceability === "irreplaceable" ||
    (row.role !== null && PROTECTED_ROLES.has(row.role)) ||
    row.lifecycle === "active"
  ) {
    return "protected";
  }
  if (row.cleanup_reason && SAFE_REASONS.has(row.cleanup_reason)) return "safe";
  if (row.cleanup_reason === "finished-project-cruft") return "review";
  if (row.reclaimable_bytes > 0) return "review";
  return "keep";
}

export type VerdictStyle = { bg: string; bd: string; tx: string; icon: string; label: string };

/**
 * Four internal states, THREE labels a user reads. `protected` and `keep` are
 * rendered identically — the difference between "we won't let you" and "we
 * think you want this" is ours, not theirs, and a fourth label is a legend to
 * memorise across hundreds of rows.
 *
 * Merging the labels must never merge the behaviour: see `canStage`, where
 * `protected` is still unstageable and `keep` is not.
 */
/** One grey, shared by both states, so the two can never drift apart visually. */
const DONT_TOUCH: VerdictStyle = {
  bg: "var(--color-keep-bg)",
  bd: "var(--color-keep-bd)",
  tx: "var(--color-keep-tx)",
  icon: "●",
  label: "Don't touch",
};

export const VERDICT_STYLES: Record<Verdict, VerdictStyle> = {
  safe: {
    bg: "var(--color-safe-bg)",
    bd: "var(--color-safe-bd)",
    tx: "var(--color-safe-tx)",
    icon: "✓",
    label: "Safe to delete",
  },
  review: {
    bg: "var(--color-review-bg)",
    bd: "var(--color-review-bd)",
    tx: "var(--color-review-tx)",
    icon: "◐",
    label: "Check first",
  },
  protected: DONT_TOUCH,
  keep: DONT_TOUCH,
};

/** The three labels, in order, for legends and filters. `protected` stands in for both grey states. */
export const VERDICT_LEGEND: Verdict[] = ["safe", "review", "protected"];

/** Neutral fill used before the analysis has classified a folder — no claim made. */
export const NEUTRAL_STYLE = {
  bg: "var(--color-inset)",
  bd: "var(--color-line)",
  tx: "var(--color-faint)",
};

export function canStage(verdict: Verdict, reclaimableBytes: number): boolean {
  return verdict !== "protected" && reclaimableBytes > 0;
}

/**
 * The "why" half of every recommendation, said out loud rather than specified.
 * Same facts as the backend taxonomy — "you can rebuild it", not "regenerable
 * output"; "a build cache", not "scratch".
 */
export function explainFolder(row: Pick<
  NativeTreemapLensFolder,
  "role" | "replaceability" | "lifecycle" | "cleanup_reason"
>): string {
  const parts: string[] = [];
  if (row.role) parts.push(roleText(row.role));
  const replaceability = replaceabilityText(row.role, row.replaceability);
  if (replaceability) parts.push(replaceability);
  if (row.lifecycle === "active") parts.push("part of something you're still working on");
  if (row.lifecycle === "finished") parts.push("from a project you've finished");
  if (row.lifecycle === "archived") parts.push("from a project you've archived");
  if (!parts.length) return "Bird's Eye hasn't worked out what this folder is yet.";
  return capitalize(parts.join(" · ")) + ".";
}

/**
 * "Regenerable" means something different depending on what the folder IS, and the difference is
 * not cosmetic: a redundant backup is regenerable because *another copy survives*, never because
 * you could recreate it. Appending one generic clause to every role produced "A backup copy · you
 * can rebuild it." — a sentence that is false, that nobody would say out loud, and that could talk
 * someone into deleting the only copy they have.
 */
function replaceabilityText(role: string | null, replaceability: string | null): string | null {
  if (replaceability === "irreplaceable") {
    return role === "backup" ? "there's no other copy of it" : "there's nothing to rebuild it from";
  }
  if (replaceability !== "regenerable") return null;
  switch (role) {
    case "backup":
      return "there's another copy of it";
    case "scratch":
      return "it fills itself back in when it's needed";
    case "derivative":
      return "you can build it again";
    case "tool":
      return "you can install it again";
    default:
      // Role unknown — say only what replaceability actually licenses, and no more.
      return "you can get it back";
  }
}

function roleText(role: string): string {
  switch (role) {
    case "derivative":
      return "something a build produced";
    case "backup":
      return "a backup copy";
    case "scratch":
      return "a build cache";
    case "source":
      return "your own source files";
    case "asset":
      return "files a project needs";
    case "system":
      return "files Windows needs";
    case "tool":
      return "a tool you installed";
    default:
      return role;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
