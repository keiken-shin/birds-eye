import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  listNativeIndexes,
  ontologyStatus,
  queryNativeIndex,
  treemapLensData,
  type NativeIndexEntry,
  type NativeIndexOverview,
  type NativeTreemapLensFolder,
} from "@bridge/nativeClient";
import { buildFolderTree, type FolderTree } from "../lib/folderTree";
import { useWorkspace } from "./workspaceStore";

type DataStatus = "no-index" | "loading" | "ready" | "error";

type IndexDataValue = {
  status: DataStatus;
  error: string | null;
  indexes: NativeIndexEntry[];
  activeEntry: NativeIndexEntry | null;
  overview: NativeIndexOverview | null;
  tree: FolderTree | null;
  lensByPath: Map<string, NativeTreemapLensFolder>;
  reclaimableTotal: number;
  refreshIndexes: () => Promise<void>;
  refreshData: () => Promise<void>;
};

const IndexDataContext = createContext<IndexDataValue | null>(null);
const QUERY_LIMIT = 4000;

export function IndexDataProvider({ children }: { children: ReactNode }) {
  const { indexPath, setIndexPath, setOntologyEnabled } = useWorkspace();
  const [indexes, setIndexes] = useState<NativeIndexEntry[]>([]);
  const [overview, setOverview] = useState<NativeIndexOverview | null>(null);
  const [tree, setTree] = useState<FolderTree | null>(null);
  const [lensByPath, setLensByPath] = useState<Map<string, NativeTreemapLensFolder>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const activeEntry = useMemo(
    () => indexes.find((e) => e.index_path === indexPath) ?? null,
    [indexes, indexPath]
  );

  const refreshIndexes = useCallback(async () => {
    try {
      const list = await listNativeIndexes();
      list.sort((a, b) => (b.last_scanned_at ?? 0) - (a.last_scanned_at ?? 0));
      setIndexes(list);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const refreshData = useCallback(async () => {
    if (!indexPath) {
      setOverview(null);
      setTree(null);
      setLensByPath(new Map());
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const rootPath = indexes.find((e) => e.index_path === indexPath)?.root_path ?? null;
      const [ov, lens, ont] = await Promise.all([
        queryNativeIndex(indexPath, QUERY_LIMIT),
        treemapLensData(indexPath).catch(() => [] as NativeTreemapLensFolder[]),
        ontologyStatus(indexPath).catch(() => ({ enabled: false, pending_discoveries: 0 })),
      ]);
      if (id !== reqId.current) return; // a newer request superseded this one
      setOverview(ov);
      setTree(buildFolderTree(ov.folders, rootPath));
      setLensByPath(new Map(lens.map((r) => [r.folder_path, r])));
      setOntologyEnabled(ont.enabled);
    } catch (e) {
      if (id === reqId.current) setError(String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [indexPath, indexes, setOntologyEnabled]);

  useEffect(() => {
    void refreshIndexes();
  }, [refreshIndexes]);

  // Auto-select the most recent scan once indexes load and nothing is active.
  useEffect(() => {
    if (!indexPath && indexes.length) setIndexPath(indexes[0].index_path);
  }, [indexPath, indexes, setIndexPath]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  const reclaimableTotal = useMemo(() => {
    if (!tree) return 0;
    return tree.topLevel.reduce((s, n) => s + (lensByPath.get(n.path)?.reclaimable_bytes ?? 0), 0);
  }, [tree, lensByPath]);

  const status: DataStatus = !indexPath
    ? "no-index"
    : error
      ? "error"
      : loading && !overview
        ? "loading"
        : "ready";

  const value = useMemo<IndexDataValue>(
    () => ({
      status,
      error,
      indexes,
      activeEntry,
      overview,
      tree,
      lensByPath,
      reclaimableTotal,
      refreshIndexes,
      refreshData,
    }),
    [status, error, indexes, activeEntry, overview, tree, lensByPath, reclaimableTotal, refreshIndexes, refreshData]
  );

  return <IndexDataContext.Provider value={value}>{children}</IndexDataContext.Provider>;
}

export function useIndexData() {
  const ctx = useContext(IndexDataContext);
  if (!ctx) throw new Error("useIndexData must be used within IndexDataProvider");
  return ctx;
}
