import type { NativeSavedView } from "@bridge/nativeClient";
import type { ResultsQuery, StageView } from "../state/types";

/**
 * The command spine's keyword router. A typed line resolves, in priority order, to:
 *  1. a stage view when it clearly names one ("duplicates", "cleanup", "timeline"),
 *  2. a curated saved view ("old files", "unclassified", "regenerable"),
 *  3. a literal `search_files` query (everything else).
 * Triggers match on whole words so a filename search isn't hijacked; the Files
 * view's own search box is always literal, so nothing is unreachable.
 *
 * Pure and view-list-driven so it's unit-checkable and never invents a view the backend lacks.
 */
export type Intent = ResultsQuery | { kind: "stage"; view: StageView };

const STAGE_TRIGGERS: Array<{ view: StageView; words: string[] }> = [
  { view: "duplicates", words: ["duplicates", "duplicate", "dupes", "dups", "identical files"] },
  { view: "cleanup", words: ["cleanup", "clean up", "clean", "safe to delete", "reclaim", "free space"] },
  { view: "timeline", words: ["timeline", "activity", "history", "growth"] },
  { view: "treemap", words: ["treemap", "map"] },
  { view: "overview", words: ["overview", "home", "dashboard"] },
  { view: "files", words: ["large files", "big files", "biggest files", "largest files"] },
  { view: "scans", words: ["scans", "scan queue", "queue", "rescan", "indexes"] },
];

const VIEW_TRIGGERS: Array<{ id: string; words: string[] }> = [
  { id: "regenerable-large", words: ["regenerable", "derivative", "derivatives", "regen", "rebuildable"] },
  { id: "orphan-backups", words: ["orphan backup", "orphan backups", "orphaned backups", "lone backups"] },
  { id: "orphan-sources", words: ["orphan source", "orphan sources", "orphaned sources"] },
  { id: "unclassified", words: ["unclassified", "unsorted", "no role"] },
  { id: "unprojected-files", words: ["unprojected", "no project", "not in a project"] },
  { id: "finished-untouched", words: ["old", "stale", "finished", "untouched", "archived", "abandoned"] },
];

function hasWord(haystack: string, needle: string): boolean {
  // whole-word / whole-phrase match, so "background.png" doesn't trip "old".
  return new RegExp(`(^|\\W)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`).test(haystack);
}

export function parseIntent(input: string, views: NativeSavedView[]): Intent | null {
  const text = input.trim();
  if (!text) return null;
  const norm = text.toLowerCase();

  for (const trigger of STAGE_TRIGGERS) {
    if (trigger.words.some((w) => hasWord(norm, w))) {
      return { kind: "stage", view: trigger.view };
    }
  }

  for (const trigger of VIEW_TRIGGERS) {
    if (!views.some((v) => v.id === trigger.id)) continue; // only route to views the backend offers
    if (trigger.words.some((w) => hasWord(norm, w))) {
      const view = views.find((v) => v.id === trigger.id)!;
      return { kind: "view", viewId: view.id, viewName: view.name };
    }
  }
  return { kind: "search", text };
}
