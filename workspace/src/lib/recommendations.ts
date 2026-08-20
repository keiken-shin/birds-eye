import { ageDays, lastSegment } from "@bridge/domain";
import type { NativeOverviewFile, NativeTreemapLensFolder } from "@bridge/nativeClient";
import { explainFolder, verdictForFolder } from "./verdict";
import type { Verdict } from "../state/types";

/**
 * One recommendation row — the shape both the landing (Overview) and the full
 * list (Clean up) render.
 *
 * The row is the ad: name · how much space · how long since you touched it · a
 * reason in plain English. `age` is null only when the backend genuinely has no
 * timestamp for the thing; the row says so rather than guessing a number.
 */
export type RecItem = {
  path: string;
  name: string;
  /** Bytes freed when known, else file size. */
  bytes: number;
  /** "untouched 8 months" — always a number, never a category. Null = not known. */
  age: string | null;
  /** Why it's here, in plain English. */
  why: string;
  verdict: Verdict;
  kind: "folder" | "file";
  reason: string | null;
  /**
   * The index row, for file rows. Null for folders — a folder recommendation is
   * a path-prefix scope by nature, and the lens rows carry folder ids, not file
   * ones. Carried so staging a file records what was reviewed.
   */
  fileId: number | null;
};

/** Every cleanup reason the backend can attach to a folder, safest first. */
export const ALL_CLEANUP_REASONS = [
  "safe-derivative",
  "scratch",
  "redundant-backup",
  "finished-project-cruft",
];

/** "untouched 8 months" / "untouched 2.4 years" — the number is the argument. */
export function untouchedFor(days: number): string {
  if (days >= 365) {
    const years = days / 365;
    // "1.0 years" is a machine talking, twice over: nobody says the trailing .0, and
    // nobody pluralises one. Say "untouched 1 year".
    const n = years >= 10 ? String(Math.round(years)) : years.toFixed(1).replace(/\.0$/, "");
    return `untouched ${n} ${n === "1" ? "year" : "years"}`;
  }
  const months = Math.max(1, Math.round(days / 30));
  return `untouched ${months} ${months === 1 ? "month" : "months"}`;
}

/**
 * Age phrase for a unix-seconds timestamp, or null when there isn't a real one.
 * Routes through `ageDays`, so a lost/reset mtime (the 1980 FAT epoch) reads as
 * unknown rather than "untouched 46 years".
 */
export function untouchedSince(modifiedAt: number | null): string | null {
  const days = ageDays(modifiedAt);
  return days === null ? null : untouchedFor(days);
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const isAncestor = (parent: string, child: string) => child.startsWith(parent + "/");

/** Lens rows for the given reasons — root excluded, zero-reclaim excluded, shallowest wins. */
export function folderRecommendations(
  rows: NativeTreemapLensFolder[],
  reasons: Set<string>,
  rootPath: string | null
): RecItem[] {
  const root = rootPath ? norm(rootPath) : null;
  const cands = rows.filter(
    (r) =>
      r.cleanup_reason !== null &&
      reasons.has(r.cleanup_reason) &&
      r.reclaimable_bytes > 0 &&
      norm(r.folder_path) !== root
  );
  const paths = cands.map((r) => norm(r.folder_path));
  return cands
    .filter((_, i) => !paths.some((p, k) => k !== i && isAncestor(p, paths[i])))
    .sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes)
    .map((r) => ({
      path: r.folder_path,
      name: lastSegment(r.folder_path),
      bytes: r.reclaimable_bytes,
      age: untouchedSince(r.modified_at),
      why: explainFolder(r),
      verdict: verdictForFolder(r),
      kind: "folder" as const,
      reason: r.cleanup_reason,
      fileId: null,
    }));
}

/** Big files nothing has opened in over a year. */
export function staleFileRecommendations(files: NativeOverviewFile[], limit = 8): RecItem[] {
  return files
    .map((f) => ({ f, days: ageDays(f.modified_at) }))
    .filter(({ days }) => days !== null && days >= 365)
    .sort((a, b) => b.f.size - a.f.size)
    .slice(0, limit)
    .map(({ f, days }) => ({
      path: f.path,
      name: lastSegment(f.path),
      bytes: f.size,
      age: untouchedFor(days!),
      why: "You haven't opened it in over a year.",
      verdict: "review" as const,
      kind: "file" as const,
      reason: null,
      fileId: f.file_id,
    }));
}

/** The landing's top reasons — biggest first, across every cleanup reason. */
export function topRecommendations(
  rows: NativeTreemapLensFolder[],
  rootPath: string | null,
  limit = 5
): RecItem[] {
  return folderRecommendations(rows, new Set(ALL_CLEANUP_REASONS), rootPath).slice(0, limit);
}
