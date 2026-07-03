export type Lens = "treemap" | "board" | "results";
export type Overlay = "scan" | "settings" | "shortcuts" | "library" | "queue" | "duplicates" | null;

/** Verdict taxonomy derived from the real backend (src/index/schema.rs cleanup view). */
export type Verdict = "safe" | "review" | "protected" | "keep";

/** What the Inspector is bound to. Folders are the primary M1 target (treemap nodes). */
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

export type UndoState = { entryIds: number[]; freed: number } | null;

/** A folder collected onto the Board lens (the selection→board glue). Folders are Inspector-able. */
export type PinnedCard = { path: string; name: string; bytes: number };

/**
 * What the Results lens is showing. The command spine (M4) and the lens's own controls
 * both produce one of these via `runQuery`, which is the single source the fetch keys on —
 * free-text search (`search_files`) or a curated saved view (`run_saved_view`).
 */
export type ResultsQuery =
  | { kind: "search"; text: string }
  | { kind: "view"; viewId: string; viewName: string };
