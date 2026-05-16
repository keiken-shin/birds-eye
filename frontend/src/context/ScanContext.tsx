import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type React from "react";
import { useNativeRuntime } from "../hooks/useNativeRuntime";
import { useSavedIndexes } from "../hooks/useSavedIndexes";
import { useScan } from "../hooks/useScan";
import type { CategoryKey, FolderStats, QueueItem, ScanState } from "../domain";
import type { NativeIndexEntry } from "../nativeClient";

type ScanContextValue = {
  nativeRuntime: boolean;
  runtimeMessage: string;
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
  savedIndexes: NativeIndexEntry[];
  refreshSavedIndexes: () => Promise<void>;
  scan: ScanState;
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
  queueItems: QueueItem[];
  loadQueueItem: (id: string) => Promise<void>;
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
  const scanApi = useScan({ nativeRuntime, setRuntimeMessage, refreshSavedIndexes });

  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const activeQueueIdRef = useRef<string | null>(null);
  const prevStatusRef = useRef(scanApi.scan.status);

  // Add queue item when scan starts, update on progress, resolve on complete/cancel
  useEffect(() => {
    const prev = prevStatusRef.current;
    const current = scanApi.scan.status;
    prevStatusRef.current = current;

    if (prev === "idle" && current === "scanning") {
      const id = crypto.randomUUID();
      activeQueueIdRef.current = id;
      setQueueItems((items) => [
        ...items,
        { id, rootName: scanApi.scan.rootName, status: "scanning", progress: 0, indexPath: "", logs: [] },
      ]);
    }

    if (prev !== "complete" && current === "complete" && activeQueueIdRef.current && scanApi.currentIndexPath) {
      const id = activeQueueIdRef.current;
      activeQueueIdRef.current = null;
      setQueueItems((items) =>
        items.map((item) =>
          item.id === id
            ? {
                ...item,
                status: "done",
                progress: 100,
                indexPath: scanApi.currentIndexPath!,
                totalFiles: scanApi.scan.totalFiles,
                totalBytes: scanApi.scan.totalBytes,
                elapsedMs: scanApi.scan.elapsedMs,
              }
            : item
        )
      );
    }

    if (current === "cancelled" && activeQueueIdRef.current) {
      const id = activeQueueIdRef.current;
      activeQueueIdRef.current = null;
      setQueueItems((items) => items.filter((item) => item.id !== id));
    }
  }, [scanApi.scan.status]);

  // Update progress on active scanning item
  useEffect(() => {
    const id = activeQueueIdRef.current;
    if (!id || scanApi.scan.status !== "scanning") return;
    const progress =
      scanApi.scan.totalFiles > 0
        ? Math.round((scanApi.scan.processedFiles / scanApi.scan.totalFiles) * 100)
        : 0;
    setQueueItems((items) =>
      items.map((item) =>
        item.id === id ? { ...item, progress, rootName: scanApi.scan.rootName } : item
      )
    );
  }, [scanApi.scan.processedFiles, scanApi.scan.totalFiles, scanApi.scan.status]);

  const loadQueueItem = useCallback(
    async (id: string) => {
      const item = queueItems.find((q) => q.id === id);
      if (!item || !item.indexPath) return;

      await scanApi.openSavedIndex({
        index_path: item.indexPath,
        root_path: item.rootName,
        last_status: "Completed",
        last_scanned_at: null,
        files_scanned: item.totalFiles ?? 0,
        folders_scanned: 0,
        bytes_scanned: item.totalBytes ?? 0,
      });

      setQueueItems((items) =>
        items.map((q) => (q.id === id ? { ...q, status: "loaded", loadedAt: Date.now() } : q))
      );

      setTimeout(() => {
        setQueueItems((items) => items.filter((q) => q.id !== id));
      }, 5000);
    },
    [queueItems, scanApi]
  );

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
        loadQueueItem,
      }}
    >
      {children}
    </ScanContext.Provider>
  );
}
