import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelNativeScan,
  chooseNativeFolder,
  listenNativeJobEvents,
  nativeJobEvents,
  queryNativeIndex,
  startNativeScan,
  type NativeIndexEntry,
  type NativeJobEvent,
} from "../nativeClient";
import {
  initialScanState,
  lastSegment,
  type CategoryKey,
  type FolderStats,
  type ScanState,
  type ScanWorkerCommand,
  type ScanWorkerMessage,
} from "../domain";
import { nativeJobEventFingerprint, mergeNativeOverview } from "../utils/scanUtils";
import { parentPath, isDescendantPath } from "../utils/pathUtils";

type NativeEventState = {
  maxFilesScanned: number;
  maxBytesScanned: number;
  seenFingerprints: Set<string>;
};

function postWorker(worker: Worker | null, message: ScanWorkerCommand) {
  worker?.postMessage(message);
}

export function useScan({
  nativeRuntime,
  setRuntimeMessage,
  refreshSavedIndexes,
}: {
  nativeRuntime: boolean;
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
  refreshSavedIndexes: () => Promise<void>;
}): {
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
} {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nativeJobRef = useRef<{ jobId: number; indexPath: string } | null>(null);
  const isWaitingForJobId = useRef(false);
  const nativeEventStateRef = useRef(new Map<number, NativeEventState>());
  const [scan, setScan] = useState<ScanState>(initialScanState);
  const [filter, setFilter] = useState<CategoryKey | "all">("all");
  const [currentIndexPath, setCurrentIndexPath] = useState<string | null>(null);
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);

  const sortedFolders = useMemo(() => {
    return [...scan.folders].sort((a, b) => b.bytes - a.bytes);
  }, [scan.folders]);

  const filteredFolders = useMemo(() => {
    const categoryFolders = filter === "all"
      ? scan.folders.map((folder) => ({ ...folder, displayBytes: folder.bytes }))
      : scan.folders
          .filter((folder) => folder.categories[filter] > 0)
          .map((folder) => ({ ...folder, displayBytes: folder.categories[filter] }));

    if (!focusedFolder) {
      return categoryFolders.sort((a, b) => b.displayBytes - a.displayBytes).slice(0, 48);
    }

    const childFolders = categoryFolders.filter((folder) => parentPath(folder.path) === focusedFolder);
    const descendantFolders = categoryFolders.filter((folder) => folder.path !== focusedFolder && isDescendantPath(folder.path, focusedFolder));
    const focused = childFolders.length > 0 ? childFolders : descendantFolders;
    return focused.sort((a, b) => b.displayBytes - a.displayBytes).slice(0, 48);
  }, [filter, focusedFolder, scan.folders]);

  function resetNativeEventState() {
    nativeEventStateRef.current.clear();
  }

  function clearNativeEventState(jobId: number) {
    nativeEventStateRef.current.delete(jobId);
  }

  function shouldIgnoreNativeJobEvent(event: NativeJobEvent) {
    const fingerprint = nativeJobEventFingerprint(event);
    const state = nativeEventStateRef.current.get(event.job_id) ?? {
      maxFilesScanned: 0,
      maxBytesScanned: 0,
      seenFingerprints: new Set<string>(),
    };

    if (state.seenFingerprints.has(fingerprint)) {
      return true;
    }

    const isTerminal = event.status === "Completed" || event.status === "Cancelled" || event.status === "Failed";
    const isOlderProgress =
      !isTerminal &&
      (event.files_scanned < state.maxFilesScanned || event.bytes_scanned < state.maxBytesScanned);

    if (isOlderProgress) {
      state.seenFingerprints.add(fingerprint);
      nativeEventStateRef.current.set(event.job_id, state);
      return true;
    }

    state.seenFingerprints.add(fingerprint);
    state.maxFilesScanned = Math.max(state.maxFilesScanned, event.files_scanned);
    state.maxBytesScanned = Math.max(state.maxBytesScanned, event.bytes_scanned);
    nativeEventStateRef.current.set(event.job_id, state);
    return false;
  }

  function stopWorker() {
    workerRef.current?.terminate();
    workerRef.current = null;
  }

  const handleNativeJobEventRef = useRef<(event: NativeJobEvent, options?: { replay?: boolean }) => Promise<void>>(async () => {});

  async function handleNativeJobEvent(event: NativeJobEvent, options: { replay?: boolean } = {}) {
    if (nativeJobRef.current?.jobId !== event.job_id) return;
    if (isWaitingForJobId.current && !options.replay) return;
    if (shouldIgnoreNativeJobEvent(event)) return;

    if (event.status === "Failed") {
      setRuntimeMessage(event.message);
    } else if (event.message === "finalizing index") {
      setRuntimeMessage("Finalizing index");
    }

    setScan((current) => ({
      ...current,
      status: event.status === "Completed" ? "complete" : event.status === "Cancelled" || event.status === "Failed" ? "cancelled" : "scanning",
      processedFiles: Math.max(current.processedFiles, event.files_scanned),
      totalFiles: Math.max(current.totalFiles, event.files_scanned),
      processedBytes: Math.max(current.processedBytes, event.bytes_scanned),
      totalBytes: Math.max(current.totalBytes, event.bytes_scanned),
      currentPath: event.current_path ?? current.currentPath,
      elapsedMs: performance.now() - current.startedAt,
    }));

    if (event.status === "Completed" && nativeJobRef.current) {
      const indexPath = nativeJobRef.current.indexPath;
      const overview = await queryNativeIndex(indexPath, 1000);
      setScan((current) => mergeNativeOverview(current, overview));
      setCurrentIndexPath(indexPath);
      setRuntimeMessage("Native index ready");
      nativeJobRef.current = null;
      clearNativeEventState(event.job_id);
      void refreshSavedIndexes();
      return;
    }

    if (event.status === "Cancelled" || event.status === "Failed") {
      nativeJobRef.current = null;
      clearNativeEventState(event.job_id);
    }
  }
  handleNativeJobEventRef.current = handleNativeJobEvent;

  async function startNativeFolderScan() {
    try {
      const folder = await chooseNativeFolder();
      if (!folder) return;

      stopWorker();
      setFilter("all");
      setFocusedFolder(null);
      setCurrentIndexPath(null);
      setRuntimeMessage("Native scan starting");

      isWaitingForJobId.current = true;
      resetNativeEventState();

      const { jobId, indexPath } = await startNativeScan(folder);
      nativeJobRef.current = { jobId, indexPath };

      setScan({
        ...initialScanState,
        status: "scanning",
        rootName: lastSegment(folder) || folder,
        startedAt: performance.now(),
        currentPath: folder,
      });

      const missedEvents = await nativeJobEvents(jobId, 0);
      for (const event of missedEvents) {
        await handleNativeJobEvent(event, { replay: true });
      }

      if (!nativeJobRef.current || nativeJobRef.current.jobId === jobId) {
        isWaitingForJobId.current = false;
      }
      if (nativeJobRef.current?.jobId === jobId) {
        setRuntimeMessage("Native index mode");
      }
    } catch (error) {
      isWaitingForJobId.current = false;
      nativeJobRef.current = null;
      setRuntimeMessage(error instanceof Error ? error.message : "Native scan failed");
      setScan((current) => ({ ...current, status: "cancelled" }));
    }
  }

  useEffect(() => {
    if (!nativeRuntime) return;

    let unlisten: (() => void) | null = null;
    void listenNativeJobEvents((event) => {
      void handleNativeJobEventRef.current?.(event);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [nativeRuntime]);

  const openFolderPicker = useCallback(() => {
    if (nativeRuntime) {
      void startNativeFolderScan();
      return;
    }
    const input = fileInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.click();
  }, [nativeRuntime]);

  const handleFiles = useCallback((fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    stopWorker();
    setFilter("all");
    setFocusedFolder(null);
    setCurrentIndexPath(null);
    setScan({
      ...initialScanState,
      status: "scanning",
      rootName: "Preparing scan...",
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      startedAt: performance.now(),
    });

    const worker = new Worker(new URL("../scanWorker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<ScanWorkerMessage>) => {
      const message = event.data;
      setScan({ ...message.payload });

      if (message.type === "finished" || message.type === "cancelled") {
        worker.terminate();
        if (workerRef.current === worker) {
          workerRef.current = null;
        }
      }
    };

    postWorker(worker, { type: "start", files });
  }, []);

  const pauseScan = useCallback(() => {
    postWorker(workerRef.current, { type: "pause" });
    setScan((current) => ({ ...current, status: "paused" }));
  }, []);

  const resumeScan = useCallback(() => {
    postWorker(workerRef.current, { type: "resume" });
    setScan((current) => ({ ...current, status: "scanning" }));
  }, []);

  const cancelScan = useCallback(() => {
    if (nativeJobRef.current) {
      void cancelNativeScan(nativeJobRef.current.jobId);
      return;
    }
    postWorker(workerRef.current, { type: "cancel" });
  }, []);

  const clearScan = useCallback(() => {
    stopWorker();
    nativeJobRef.current = null;
    isWaitingForJobId.current = false;
    resetNativeEventState();
    setFilter("all");
    setFocusedFolder(null);
    setCurrentIndexPath(null);
    setScan(initialScanState);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const openSavedIndex = useCallback(async (entry: NativeIndexEntry) => {
    const overview = await queryNativeIndex(entry.index_path, 1000);
    setScan((current) => ({
      ...mergeNativeOverview(current.status === "idle" ? initialScanState : current, overview),
      status: "complete",
      rootName: entry.root_path ? lastSegment(entry.root_path) : "Saved index",
      processedFiles: entry.files_scanned,
      totalFiles: entry.files_scanned,
      processedBytes: entry.bytes_scanned,
      totalBytes: entry.bytes_scanned,
      currentPath: entry.root_path ?? entry.index_path,
    }));
    setCurrentIndexPath(entry.index_path);
    setRuntimeMessage("Saved index loaded");
    window.location.hash = "dashboard";
  }, [setRuntimeMessage]);

  const rescanSavedIndex = useCallback(async (entry: NativeIndexEntry) => {
    if (!entry.root_path) return;

    stopWorker();
    setFilter("all");
    setFocusedFolder(null);
    setCurrentIndexPath(null);
    setRuntimeMessage("Native rescan starting");

    isWaitingForJobId.current = true;
    resetNativeEventState();

    let jobId: number;
    let indexPath: string;
    try {
      ({ jobId, indexPath } = await startNativeScan(entry.root_path));
    } catch (error) {
      nativeJobRef.current = null;
      isWaitingForJobId.current = false;
      setRuntimeMessage(error instanceof Error ? error.message : "Native rescan failed");
      setScan((current) => ({ ...current, status: "cancelled" }));
      window.location.hash = "scan";
      return;
    }
    nativeJobRef.current = { jobId, indexPath };

    setScan({
      ...initialScanState,
      status: "scanning",
      rootName: lastSegment(entry.root_path) || entry.root_path,
      startedAt: performance.now(),
      currentPath: entry.root_path,
    });

    const missedEvents = await nativeJobEvents(jobId, 0);
    for (const event of missedEvents) {
      await handleNativeJobEvent(event, { replay: true });
    }

    if (!nativeJobRef.current || nativeJobRef.current.jobId === jobId) {
      isWaitingForJobId.current = false;
    }
    if (nativeJobRef.current?.jobId === jobId) {
      setRuntimeMessage("Native index mode");
    }

    window.location.hash = "scan";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRuntimeMessage]);

  return {
    scan,
    filter,
    setFilter,
    focusedFolder,
    setFocusedFolder,
    sortedFolders,
    filteredFolders,
    currentIndexPath,
    fileInputRef,
    openFolderPicker,
    handleFiles,
    pauseScan,
    resumeScan,
    cancelScan,
    clearScan,
    openSavedIndex,
    rescanSavedIndex,
  };
}
