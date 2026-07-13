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
  folderChildren,
  listNativeIndexes,
  ontologyStatus,
  queryNativeIndex,
  treemapLensData,
  type NativeIndexEntry,
  type NativeIndexOverview,
  type NativeOntologyStatus,
  type NativeTreemapLensFolder,
} from "@bridge/nativeClient";
import { buildFolderTree, type FolderRow, type FolderTree } from "../lib/folderTree";
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
  /** Last ontology status read — includes per-populator enrichment progress. */
  ontology: NativeOntologyStatus | null;
  /** Bumps on every successful refreshData — lets lenses (e.g. Board) refetch after enrichment. */
  dataVersion: number;
  refreshIndexes: () => Promise<void>;
  refreshData: () => Promise<void>;
  /** Fetch one folder's direct children (they may be below the overview's
   *  top-N cut) and merge them into the tree. Resolves true if any exist. */
  loadFolderChildren: (parentPath: string) => Promise<boolean>;
};

const IndexDataContext = createContext<IndexDataValue | null>(null);
const QUERY_LIMIT = 4000;

export function IndexDataProvider({ children }: { children: ReactNode }) {
  const { indexPath, setIndexPath, setOntologyEnabled } = useWorkspace();
  const [indexes, setIndexes] = useState<NativeIndexEntry[]>([]);
  const [overview, setOverview] = useState<NativeIndexOverview | null>(null);
  const [extraFolders, setExtraFolders] = useState<FolderRow[]>([]);
  const [lensByPath, setLensByPath] = useState<Map<string, NativeTreemapLensFolder>>(new Map());
  const [ontology, setOntology] = useState<NativeOntologyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dataVersion, setDataVersion] = useState(0);
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
      setExtraFolders([]);
      setLensByPath(new Map());
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const [ov, lens, ont] = await Promise.all([
        queryNativeIndex(indexPath, QUERY_LIMIT),
        treemapLensData(indexPath).catch(() => [] as NativeTreemapLensFolder[]),
        // null (not false) on error: a status-read failure must not silently report a
        // just-enabled index as disabled and bounce the UI back to the opt-in prompt.
        ontologyStatus(indexPath).catch(() => null),
      ]);
      if (id !== reqId.current) return; // a newer request superseded this one
      setOverview(ov);
      setExtraFolders([]); // fresh scan data invalidates lazily drilled-in folders
      setLensByPath(new Map(lens.map((r) => [r.folder_path, r])));
      if (ont) {
        setOntologyEnabled(ont.enabled);
        setOntology(ont);
      }
      setDataVersion((v) => v + 1); // signal lenses that fresh data (incl. enrichment) landed
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

  // The tree over the overview's top-N folders plus any drilled-in children.
  const tree: FolderTree | null = useMemo(() => {
    if (!overview) return null;
    const rootPath = activeEntry?.root_path ?? null;
    const seen = new Set<string>();
    const rows = [...overview.folders, ...extraFolders].filter(
      (f) => !seen.has(f.path) && (seen.add(f.path), true)
    );
    return buildFolderTree(rows, rootPath);
  }, [overview, extraFolders, activeEntry]);

  const loadFolderChildren = useCallback(
    async (parentPath: string): Promise<boolean> => {
      if (!indexPath) return false;
      try {
        const rows = await folderChildren(indexPath, parentPath);
        if (!rows.length) return false;
        setExtraFolders((prev) => {
          const have = new Set(prev.map((p) => p.path));
          const fresh = rows.filter((r) => !have.has(r.path));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        return true;
      } catch {
        return false;
      }
    },
    [indexPath]
  );

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
      ontology,
      dataVersion,
      refreshIndexes,
      refreshData,
      loadFolderChildren,
    }),
    [status, error, indexes, activeEntry, overview, tree, lensByPath, reclaimableTotal, ontology, dataVersion, refreshIndexes, refreshData, loadFolderChildren]
  );

  return <IndexDataContext.Provider value={value}>{children}</IndexDataContext.Provider>;
}

export function useIndexData() {
  const ctx = useContext(IndexDataContext);
  if (!ctx) throw new Error("useIndexData must be used within IndexDataProvider");
  return ctx;
}
