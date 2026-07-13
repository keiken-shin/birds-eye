import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  Overlay,
  PinnedCard,
  ResultsQuery,
  SelectedRef,
  StagedItem,
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
  pinned: PinnedCard[];
  resultsQuery: ResultsQuery | null;
  overlay: Overlay;
  review: boolean;
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
  pinToBoard: (card: PinnedCard) => void;
  unpinCard: (path: string) => void;
  isPinned: (path: string) => boolean;
  /** Drive the Files view (from the command spine or the view's controls) and switch to it. */
  runQuery: (query: ResultsQuery) => void;
  /** Drop the active results query (Files view falls back to the largest-files preset). */
  clearQuery: () => void;
  setOverlay: (overlay: Overlay) => void;
  openReview: () => void;
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
  const [pinned, setPinned] = useState<PinnedCard[]>([]);
  const [resultsQuery, setResultsQuery] = useState<ResultsQuery | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [review, setReview] = useState(false);
  const [undo, setUndo] = useState<UndoState>(null);

  const closeReview = useCallback(() => setReview(false), []);

  const drillInto = useCallback((folderPath: string) => {
    setScopePath((prev) => (prev[prev.length - 1] === folderPath ? prev : [...prev, folderPath]));
  }, []);
  const popScopeTo = useCallback((depth: number) => {
    setScopePath((prev) => prev.slice(0, depth));
  }, []);
  const select = useCallback((ref: SelectedRef | null) => setSelected(ref), []);

  const toggleStaged = useCallback((item: StagedItem) => {
    setStaged((prev) => {
      const i = prev.findIndex((s) => s.path === item.path);
      if (i >= 0) return prev.filter((_, k) => k !== i);
      return [...prev, item];
    });
  }, []);
  const isStaged = useCallback((path: string) => staged.some((s) => s.path === path), [staged]);
  const clearStaged = useCallback(() => setStaged([]), []);

  // Pinning collects quietly — it never yanks you out of the view you're in.
  // The Board shows the card next time you flip to it (rail badge signals it).
  const pinToBoard = useCallback((card: PinnedCard) => {
    setPinned((prev) => (prev.some((p) => p.path === card.path) ? prev : [...prev, card]));
  }, []);
  const unpinCard = useCallback((path: string) => {
    setPinned((prev) => prev.filter((p) => p.path !== path));
  }, []);
  const isPinned = useCallback((path: string) => pinned.some((p) => p.path === path), [pinned]);
  const runQuery = useCallback((query: ResultsQuery) => {
    setResultsQuery(query);
    setView("files");
  }, []);
  const clearQuery = useCallback(() => setResultsQuery(null), []);
  const openReview = useCallback(() => {
    if (staged.length) setReview(true);
  }, [staged.length]);

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      indexPath,
      ontologyEnabled,
      view,
      scopePath,
      selected,
      staged,
      pinned,
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
      isStaged,
      clearStaged,
      pinToBoard,
      unpinCard,
      isPinned,
      runQuery,
      clearQuery,
      setOverlay,
      openReview,
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
      pinned,
      resultsQuery,
      overlay,
      review,
      undo,
      drillInto,
      popScopeTo,
      select,
      toggleStaged,
      isStaged,
      clearStaged,
      pinToBoard,
      unpinCard,
      isPinned,
      runQuery,
      clearQuery,
      openReview,
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
