import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  clearStagedItems,
  setStagedGroup,
  stageItem,
  stagedItems,
  unstageItem,
} from "@bridge/nativeClient";
import type {
  Overlay,
  ResultsQuery,
  ReviewMode,
  SelectedRef,
  StagedItem,
  StagedMove,
  StageView,
  UndoState,
} from "./types";

/**
 * The two "glue" globals the architecture study calls out: selection (drives the one
 * Inspector) and the cleanup tray (collects from any view). Plus shell nav state.
 * Index data (overview / lens rows) is fetched by hooks keyed on indexPath, not held here.
 */
type WorkspaceState = {
  indexPath: string | null;
  ontologyEnabled: boolean;
  view: StageView;
  scopePath: string[]; // folder paths from root → current scope
  selected: SelectedRef | null;
  staged: StagedItem[];
  stagedMoves: StagedMove[];
  resultsQuery: ResultsQuery | null;
  overlay: Overlay;
  review: ReviewMode;
  undo: UndoState;
};

type WorkspaceActions = {
  setIndexPath: (path: string | null) => void;
  setOntologyEnabled: (enabled: boolean) => void;
  setView: (view: StageView) => void;
  setScopePath: (path: string[]) => void;
  drillInto: (folderPath: string) => void;
  popScopeTo: (depth: number) => void;
  select: (ref: SelectedRef | null) => void;
  toggleStaged: (item: StagedItem) => void;
  isStaged: (path: string) => boolean;
  clearStaged: () => void;
  /** Put staged paths in a named group, or take them out of one (null). */
  groupStaged: (paths: string[], groupName: string | null) => void;
  toggleStagedMove: (move: StagedMove) => void;
  isMoveStaged: (path: string) => boolean;
  clearStagedMoves: () => void;
  /** Drive the Files view (from the command spine or the view's controls) and switch to it. */
  runQuery: (query: ResultsQuery) => void;
  /** Drop the active results query (Files view falls back to the largest-files preset). */
  clearQuery: () => void;
  setOverlay: (overlay: Overlay) => void;
  /**
   * Open the delete gate. With `paths`, only those staged items are reviewed —
   * and only those are taken off the desk afterwards. Without, the whole desk is
   * the review set, which is what the tray's own button means.
   */
  openReview: (paths?: string[]) => void;
  /** The subset the open review covers, or null for "everything staged". */
  reviewPaths: string[] | null;
  openRelocateReview: () => void;
  closeReview: () => void;
  setUndo: (undo: UndoState) => void;
};

type WorkspaceContextValue = WorkspaceState & WorkspaceActions;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [indexPath, setIndexPath] = useState<string | null>(null);
  const [ontologyEnabled, setOntologyEnabled] = useState(false);
  const [view, setView] = useState<StageView>("overview");
  const [scopePath, setScopePath] = useState<string[]>([]);
  const [selected, setSelected] = useState<SelectedRef | null>(null);
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const [stagedMoves, setStagedMoves] = useState<StagedMove[]>([]);
  const [resultsQuery, setResultsQuery] = useState<ResultsQuery | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [review, setReview] = useState<ReviewMode>(null);
  const [reviewPaths, setReviewPaths] = useState<string[] | null>(null);
  const [undo, setUndo] = useState<UndoState>(null);

  const closeReview = useCallback(() => {
    setReview(null);
    setReviewPaths(null);
  }, []);

  const drillInto = useCallback((folderPath: string) => {
    setScopePath((prev) => (prev[prev.length - 1] === folderPath ? prev : [...prev, folderPath]));
  }, []);
  const popScopeTo = useCallback((depth: number) => {
    setScopePath((prev) => prev.slice(0, depth));
  }, []);
  const select = useCallback((ref: SelectedRef | null) => setSelected(ref), []);

  /**
   * The desk is durable: React state is the fast copy, the index is the record.
   * It used to live only here, so closing the window threw away everything a
   * person had set aside — a clipboard, not a desk. Writes go through
   * optimistically so the UI stays instant; the backend is the truth on reload.
   */
  useEffect(() => {
    if (!indexPath) {
      setStaged([]);
      return;
    }
    let alive = true;
    void stagedItems(indexPath)
      .then((rows) => {
        if (!alive) return;
        setStaged(
          rows.map((r) => ({
            path: r.path,
            name: r.name,
            bytes: r.bytes,
            reason: r.reason,
            verdict: (r.verdict as StagedItem["verdict"]) ?? "review",
            kind: r.kind,
            fileId: r.file_id,
            groupName: r.group_name,
            note: r.note,
          }))
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [indexPath]);

  const toggleStaged = useCallback(
    (item: StagedItem) => {
      setStaged((prev) => {
        const i = prev.findIndex((s) => s.path === item.path);
        if (i >= 0) {
          if (indexPath) void unstageItem(indexPath, item.path).catch(() => {});
          return prev.filter((_, k) => k !== i);
        }
        if (indexPath) {
          void stageItem(indexPath, {
            kind: item.kind,
            path: item.path,
            file_id: item.fileId,
            name: item.name,
            bytes: item.bytes,
            verdict: item.verdict,
            reason: item.reason,
            group_name: item.groupName ?? null,
            note: item.note ?? null,
          }).catch(() => {});
        }
        return [...prev, item];
      });
    },
    [indexPath]
  );
  const isStaged = useCallback((path: string) => staged.some((s) => s.path === path), [staged]);
  const clearStaged = useCallback(() => {
    setStaged([]);
    if (indexPath) void clearStagedItems(indexPath).catch(() => {});
  }, [indexPath]);

  /** Put a set of staged paths in a named group, or take them out of one. */
  const groupStaged = useCallback(
    (paths: string[], groupName: string | null) => {
      const wanted = new Set(paths);
      setStaged((prev) => prev.map((s) => (wanted.has(s.path) ? { ...s, groupName } : s)));
      if (indexPath) void setStagedGroup(indexPath, paths, groupName).catch(() => {});
    },
    [indexPath]
  );

  const toggleStagedMove = useCallback((move: StagedMove) => {
    setStagedMoves((prev) => {
      const i = prev.findIndex((s) => s.path === move.path);
      if (i >= 0) return prev.filter((_, k) => k !== i);
      return [...prev, move];
    });
  }, []);
  const isMoveStaged = useCallback(
    (path: string) => stagedMoves.some((s) => s.path === path),
    [stagedMoves]
  );
  const clearStagedMoves = useCallback(() => setStagedMoves([]), []);

  const runQuery = useCallback((query: ResultsQuery) => {
    setResultsQuery(query);
    setView("files");
  }, []);
  const clearQuery = useCallback(() => setResultsQuery(null), []);
  const openReview = useCallback(
    (paths?: string[]) => {
      if (staged.length) {
        setReviewPaths(paths && paths.length ? paths : null);
        setReview("clean");
      } else if (stagedMoves.length) setReview("relocate");
    },
    [staged.length, stagedMoves.length]
  );
  const openRelocateReview = useCallback(() => {
    if (stagedMoves.length) setReview("relocate");
  }, [stagedMoves.length]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      indexPath,
      ontologyEnabled,
      view,
      scopePath,
      selected,
      staged,
      stagedMoves,
      resultsQuery,
      overlay,
      review,
      undo,
      setIndexPath,
      setOntologyEnabled,
      setView,
      setScopePath,
      drillInto,
      popScopeTo,
      select,
      toggleStaged,
      groupStaged,
      isStaged,
      clearStaged,
      toggleStagedMove,
      isMoveStaged,
      clearStagedMoves,
      runQuery,
      clearQuery,
      setOverlay,
      openReview,
      reviewPaths,
      openRelocateReview,
      closeReview,
      setUndo,
    }),
    [
      indexPath,
      ontologyEnabled,
      view,
      scopePath,
      selected,
      staged,
      stagedMoves,
      resultsQuery,
      overlay,
      review,
      undo,
      drillInto,
      popScopeTo,
      select,
      toggleStaged,
      groupStaged,
      isStaged,
      clearStaged,
      toggleStagedMove,
      isMoveStaged,
      clearStagedMoves,
      runQuery,
      clearQuery,
      openReview,
      reviewPaths,
      openRelocateReview,
      closeReview,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
