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

export const VERDICT_STYLES: Record<Verdict, VerdictStyle> = {
  safe: { bg: "#15311f", bd: "#2f7d4e", tx: "#7fe0a6", icon: "✓", label: "Safe to remove" },
  review: { bg: "#23262e", bd: "#3a4150", tx: "#cdd2da", icon: "◐", label: "Review recommended" },
  protected: { bg: "#2a2417", bd: "#6b5630", tx: "#e0c489", icon: "🔒", label: "Protected" },
  keep: { bg: "#191c22", bd: "#2a2f38", tx: "#aab0b8", icon: "●", label: "Keep — in use" },
};

/** Neutral fill used when intelligence is disabled (size-only treemap, no verdict claimed). */
export const NEUTRAL_STYLE = { bg: "#16181d", bd: "#262a31", tx: "#aab0b8" };

export function canStage(verdict: Verdict, reclaimableBytes: number): boolean {
  return verdict !== "protected" && reclaimableBytes > 0;
}

/** Short human "why it exists" line composed from the folder's dominant attributes. */
export function explainFolder(row: Pick<
  NativeTreemapLensFolder,
  "role" | "replaceability" | "lifecycle" | "cleanup_reason"
>): string {
  const parts: string[] = [];
  if (row.role) parts.push(roleText(row.role));
  if (row.replaceability === "regenerable") parts.push("regenerable output");
  if (row.replaceability === "irreplaceable") parts.push("irreplaceable — no source to rebuild from");
  if (row.lifecycle === "active") parts.push("part of an active project");
  if (row.lifecycle === "finished" || row.lifecycle === "archived")
    parts.push(`from a ${row.lifecycle} project`);
  if (!parts.length) return "A directory in your storage.";
  return capitalize(parts.join(" · ")) + ".";
}

function roleText(role: string): string {
  switch (role) {
    case "derivative":
      return "build / derived output";
    case "backup":
      return "backup copy";
    case "scratch":
      return "scratch / cache";
    case "source":
      return "source files";
    case "asset":
      return "project assets";
    case "system":
      return "system files";
    case "tool":
      return "tooling";
    default:
      return role;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
