/**
 * The stage views — representation switches over the same index, never page
 * loads. Overview is the hub; Treemap/Board/Files are the investigation
 * lenses; Duplicates/Cleanup/Timeline are the insight views the goal comps
 * call the bare minimum.
 */
export type StageView =
  | "overview"
  | "treemap"
  | "board"
  | "files"
  | "duplicates"
  | "cleanup"
  | "timeline"
  | "scans"
  | "catalog";

export type Overlay = "scan" | "settings" | "shortcuts" | "library" | null;

/** Verdict taxonomy derived from the real backend (src/index/schema.rs cleanup view). */
export type Verdict = "safe" | "review" | "protected" | "keep";

/** What the Inspector is bound to. Folders are the primary target (treemap nodes). */
export type SelectedRef = {
  kind: "folder" | "file";
  path: string;
  name: string;
  bytes: number;
};

/** A staged cleanup item. Folder-scoped to match the backend's cleanup_plan(path_prefix). */
export type StagedItem = {
  path: string;
  name: string;
  /** reclaimable bytes when known, else total size */
  bytes: number;
  reason: string | null;
  verdict: Verdict;
  kind: "folder" | "file";
};

/**
 * A staged relocation. Deliberately NOT a StagedItem: that type has no action
 * discriminant and no destination, and ReviewModal feeds every staged path to
 * cleanup_plan as a delete scope prefix.
 */
export type StagedMove = {
  path: string;
  name: string;
  bytes: number;
  /** Absolute destination path for this one file. */
  to: string;
  destinationExists: boolean;
  fileId: number;
  discoveryId: number | null;
};

/** Which review gate is open. Both kinds can be staged at once. */
export type ReviewMode = "clean" | "relocate" | null;

export type UndoState =
  | { kind: "clean"; entryIds: number[]; freed: number }
  | { kind: "relocate"; pairs: Array<{ from: string; to: string }> }
  | null;

/** A folder collected onto the Board (the selection→board glue). */
export type PinnedCard = { path: string; name: string; bytes: number };

/**
 * What the Files view is showing. The command spine and the view's own
 * controls both produce one of these via `runQuery` — free-text search
 * (`search_files`) or a curated saved view (`run_saved_view`).
 */
export type ResultsQuery =
  | { kind: "search"; text: string }
  | { kind: "view"; viewId: string; viewName: string };
