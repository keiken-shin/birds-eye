import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type React from "react";
import { useNativeRuntime } from "../hooks/useNativeRuntime";
import { useSavedIndexes } from "../hooks/useSavedIndexes";
import { useScan } from "../hooks/useScan";
import {
  formatTimingMatrix,
  parseScanStrategy,
  type CategoryKey,
  type FolderStats,
  type QueueItem,
  type ScanLogEntry,
  type ScanState,
  type ScanStrategy,
} from "../domain";
import type { NativeIndexEntry } from "../nativeClient";

type ScanContextValue = {
  nativeRuntime: boolean;
  runtimeMessage: string;
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
  savedIndexes: NativeIndexEntry[];
  refreshSavedIndexes: () => Promise<void>;
  scan: ScanState;
  workspaceScan: ScanState | null;
  workspaceIndexPath: string | null;
  filter: CategoryKey | "all";
  setFilter: React.Dispatch<React.SetStateAction<CategoryKey | "all">>;
  focusedFolder: string | null;
  setFocusedFolder: React.Dispatch<React.SetStateAction<string | null>>;
  sortedFolders: FolderStats[];
  filteredFolders: Array<FolderStats & { displayBytes: number }>;
  currentIndexPath: string | null;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  openFolderPicker: () => void;
  handleFiles: (fileList: FileList | null) => void;
  pauseScan: () => void;
  resumeScan: () => void;
  cancelScan: () => void;
  clearScan: () => void;
  openSavedIndex: (entry: NativeIndexEntry) => Promise<void>;
  rescanSavedIndex: (entry: NativeIndexEntry) => Promise<void>;
  refreshWorkspaceIndex: () => Promise<void>;
  queueItems: QueueItem[];
  scanHistoryItems: QueueItem[];
  activeQueueId: string | null;
  loadQueueItem: (id: string) => Promise<void>;
  deleteQueueItem: (id: string) => void;
  theme: "dark" | "light" | "system";
  setTheme: React.Dispatch<React.SetStateAction<"dark" | "light" | "system">>;
  scanStrategy: ScanStrategy;
  setScanStrategy: (strategy: ScanStrategy) => void;
};

const ScanContext = createContext<ScanContextValue | null>(null);

export function useScanContext(): ScanContextValue {
  const ctx = useContext(ScanContext);
  if (!ctx) throw new Error("useScanContext must be used inside ScanProvider");
  return ctx;
}

export function ScanProvider({ children }: { children: React.ReactNode }) {
  const { nativeRuntime, runtimeMessage, setRuntimeMessage } = useNativeRuntime();
  const { savedIndexes, refreshSavedIndexes } = useSavedIndexes({ nativeRuntime, setRuntimeMessage });

  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [scanHistoryItems, setScanHistoryItems] = useState<QueueItem[]>([]);
  const [theme, setTheme] = useState<"dark" | "light" | "system">("dark");
  const [scanStrategy, setScanStrategyState] = useState<ScanStrategy>(() =>
    parseScanStrategy(window.localStorage.getItem("birds-eye.scanStrategy"))
  );
  const setScanStrategy = useCallback((strategy: ScanStrategy) => {
    setScanStrategyState(strategy);
    window.localStorage.setItem("birds-eye.scanStrategy", strategy);
  }, []);
  const scanApi = useScan({ nativeRuntime, setRuntimeMessage, refreshSavedIndexes, scanStrategy });
  const activeQueueIdRef = useRef<string | null>(null);

  // Route backend log lines into the active queue item's log
  useEffect(() => {
    if (!scanApi.lastLogEntry || !activeQueueIdRef.current) return;
    const entry = scanApi.lastLogEntry;
    const id = activeQueueIdRef.current;
    setQueueItems((items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, logs: [...item.logs, entry].slice(-5000) }
          : item
      )
    );
  }, [scanApi.lastLogEntry]);

  // Route phase timings into the active queue item's log as a timing matrix block
  useEffect(() => {
    if (!scanApi.phaseTimings || scanApi.phaseTimings.length === 0) return;
    if (!activeQueueIdRef.current) return;
    const matrixEntry: ScanLogEntry = {
      ts: Date.now(),
      level: "info",
      message: formatTimingMatrix(scanApi.phaseTimings),
      isTimingMatrix: true,
    };
    const id = activeQueueIdRef.current;
    setQueueItems((items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, logs: [...item.logs, matrixEntry].slice(-5000) }
          : item
      )
    );
  }, [scanApi.phaseTimings]);
  const prevStatusRef = useRef(scanApi.scan.status);
  const prevFolderRef = useRef<string>("");

  // Add queue item when scan starts, update on progress, resolve on complete/cancel
  useEffect(() => {
    const prev = prevStatusRef.current;
    const current = scanApi.scan.status;
    prevStatusRef.current = current;

    if (current === "scanning" && prev !== "scanning" && prev !== "paused") {
      const id = crypto.randomUUID();
      activeQueueIdRef.current = id;
      prevFolderRef.current = "";
      setQueueItems((items) => [
        ...items,
        {
          id,
          rootName: scanApi.scan.rootName,
          status: "scanning",
          progress: 0,
          progressLabel: "Scanning files",
          indexPath: "",
          logs: [{ ts: Date.now(), level: "info" as const, message: `scan started: ${scanApi.scan.rootName}` }],
        },
      ]);
    }

    if (current === "complete" && activeQueueIdRef.current && (!nativeRuntime || scanApi.currentIndexPath)) {
      const id = activeQueueIdRef.current;
      activeQueueIdRef.current = null;
      const summary = `scan complete — ${scanApi.scan.totalFiles.toLocaleString()} files, ${scanApi.scan.totalBytes > 0 ? `${(scanApi.scan.totalBytes / 1073741824).toFixed(2)} GB` : "0 B"}`;
      setQueueItems((items) => {
        const completed = items.find((item) => item.id === id);
        if (completed) {
          const historyItem: QueueItem = {
            ...completed,
            status: "done",
            progress: 100,
            progressCurrent: scanApi.scan.totalFiles,
            progressTotal: scanApi.scan.totalFiles,
            progressLabel: "Complete",
            indexPath: scanApi.currentIndexPath ?? "",
            totalFiles: scanApi.scan.totalFiles,
            totalBytes: scanApi.scan.totalBytes,
            foldersScanned: scanApi.scan.folders.length,
            elapsedMs: scanApi.scan.elapsedMs,
            logs: [...completed.logs, { ts: Date.now(), level: "info" as const, message: summary }].slice(-2000),
          };
          setScanHistoryItems((history) => [historyItem, ...history.filter((item) => item.id !== id)]);
        }
        return items.filter((item) => item.id !== id);
      });
    }

    if (current === "cancelled" && activeQueueIdRef.current) {
      const id = activeQueueIdRef.current;
      activeQueueIdRef.current = null;
      setQueueItems((items) =>
        items.map((item) =>
          item.id === id
            ? {
                ...item,
                logs: [...item.logs, { ts: Date.now(), level: "warn" as const, message: "scan cancelled" }].slice(-2000),
              }
            : item
        )
      );
      // Brief delay so the cancelled log entry is visible before item is removed
      setTimeout(() => {
        setQueueItems((items) => {
          const cancelled = items.find((item) => item.id === id);
          if (cancelled) {
            setScanHistoryItems((history) => [
              {
                ...cancelled,
                status: "done",
                progressLabel: "Cancelled",
                elapsedMs: scanApi.scan.elapsedMs,
              },
              ...history.filter((item) => item.id !== id),
            ]);
          }
          return items.filter((item) => item.id !== id);
        });
      }, 1500);
    }
  }, [nativeRuntime, scanApi.currentIndexPath, scanApi.scan.elapsedMs, scanApi.scan.folders.length, scanApi.scan.rootName, scanApi.scan.status, scanApi.scan.totalBytes, scanApi.scan.totalFiles]);

  // Update progress, status and root name on active scanning item
  useEffect(() => {
    const id = activeQueueIdRef.current;
    if (!id || (scanApi.scan.status !== "scanning" && scanApi.scan.status !== "paused")) return;
    const status: import("../domain").QueueItemStatus = scanApi.scan.finalizing ? "finalizing" : "scanning";
    const progress = scanApi.scan.progressTotal > 0
      ? Math.min(99, Math.round((scanApi.scan.progressCurrent / scanApi.scan.progressTotal) * 100))
      : scanApi.scan.totalFiles > 0
      ? Math.min(99, Math.round((scanApi.scan.processedFiles / scanApi.scan.totalFiles) * 100))
      : 0;
    setQueueItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              status,
              progress,
              progressCurrent: scanApi.scan.progressCurrent,
              progressTotal: scanApi.scan.progressTotal,
              progressLabel: scanApi.scan.progressLabel,
              rootName: scanApi.scan.rootName,
              elapsedMs: scanApi.scan.elapsedMs,
              totalFiles: Math.max(scanApi.scan.totalFiles, scanApi.scan.processedFiles),
              totalBytes: Math.max(scanApi.scan.totalBytes, scanApi.scan.processedBytes),
            }
          : item
      )
    );
  }, [scanApi.scan.processedFiles, scanApi.scan.totalFiles, scanApi.scan.finalizing, scanApi.scan.status, scanApi.scan.progressCurrent, scanApi.scan.progressTotal, scanApi.scan.progressLabel, scanApi.scan.rootName, scanApi.scan.elapsedMs, scanApi.scan.processedBytes, scanApi.scan.totalBytes]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (media?.matches ? "light" : "dark") : theme;
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
    };

    apply();
    if (theme !== "system" || !media) return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // Accumulate folder-level log entries (one entry per new folder entered)
  useEffect(() => {
    const id = activeQueueIdRef.current;
    if (!id || scanApi.scan.status !== "scanning") return;
    const currentPath = scanApi.scan.currentPath;
    if (!currentPath || currentPath === "-") return;
    const parts = currentPath.split(/[\\/]/);
    const folder = parts.length > 1 ? parts.slice(0, -1).join("\\") : currentPath;
    if (folder === prevFolderRef.current) return;
    prevFolderRef.current = folder;
    setQueueItems((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              logs: [...item.logs, { ts: Date.now(), level: "info" as const, message: `scanning  ${currentPath}` }].slice(-2000),
            }
          : item
      )
    );
  }, [scanApi.scan.currentPath, scanApi.scan.status]);

  const loadQueueItem = useCallback(
    async (id: string) => {
      const item = [...queueItems, ...scanHistoryItems].find((q) => q.id === id);
      if (!item || !item.indexPath) return;

      await scanApi.openSavedIndex({
        index_path: item.indexPath,
        root_path: item.rootName,
        last_status: "Completed",
        last_scanned_at: null,
        files_scanned: item.totalFiles ?? 0,
        folders_scanned: item.foldersScanned ?? 0,
        bytes_scanned: item.totalBytes ?? 0,
        scan_strategy: scanStrategy,
      });

      setQueueItems((items) =>
        items.map((q) => (q.id === id ? { ...q, status: "loaded", loadedAt: Date.now() } : q))
      );
      setScanHistoryItems((items) =>
        items.map((q) => (q.id === id ? { ...q, status: "loaded", loadedAt: Date.now() } : q))
      );
    },
    [queueItems, scanHistoryItems, scanApi, scanStrategy]
  );

  const deleteQueueItem = useCallback((id: string) => {
    setQueueItems((items) => items.filter((item) => item.id !== id));
    setScanHistoryItems((items) => items.filter((item) => item.id !== id));
  }, []);

  return (
    <ScanContext.Provider
      value={{
        nativeRuntime,
        runtimeMessage,
        setRuntimeMessage,
        savedIndexes,
        refreshSavedIndexes,
        ...scanApi,
        queueItems,
        scanHistoryItems,
        activeQueueId: activeQueueIdRef.current,
        loadQueueItem,
        deleteQueueItem,
        theme,
        setTheme,
        scanStrategy,
        setScanStrategy,
      }}
    >
      {children}
    </ScanContext.Provider>
  );
}



