import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import {
  ChevronLeft,
  Check,
  CopyCheck,
  Database,
  Eye,
  ExternalLink,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  Keyboard,
  MoveRight,
  Pause,
  Play,
  RotateCw,
  Search,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  categories,
  classifyFile,
  emptyCategories,
  emptyFolderCategories,
  formatBytes,
  formatCount,
  getExtension,
  initialScanState,
  lastSegment,
  type CategoryKey,
  type DuplicateOverlap,
  type FolderStats,
  type ScanState,
  type ScanWorkerCommand,
  type ScanWorkerMessage,
} from "./domain";
import {
  cancelNativeScan,
  chooseNativeFolder,
  deleteNativeIndex,
  isNativeRuntime,
  listNativeIndexes,
  listenNativeJobEvents,
  queryNativeIndex,
  queryNativeDuplicateFiles,
  recycleNativeFiles,
  refreshNativeDuplicateGroup,
  refreshNativeIndexPaths,
  revealNativePath,
  searchNativeIndex,
  startNativeScan,
  validateNativeCleanupFiles,
  type NativeDuplicateFile,
  type NativeIndexEntry,
  type NativeIndexOverview,
  type NativeJobEvent,
  type NativeSearchResult,
} from "./nativeClient";
import { TreemapCanvas } from "./TreemapCanvas";
import logoUrl from "./assets/birds-eye-logo.svg";
import "./styles.css";

type StagedAction = {
  id: string;
  label: string;
  confidence: "Safe" | "Medium" | "Risky" | "Manual review";
  bytes: number;
  reason: string;
  suggestedAction: string;
  evidence: string[];
  operation?: {
    kind: "recycleFiles";
    keepPath: string;
    removePaths: string[];
    duplicateGroupId?: number;
    keepFileId?: number;
    removeFileIds?: number[];
    keepName?: string;
    recycleFiles?: Array<{ id: number; path: string; name: string; size: number }>;
    affectedFolders?: Array<{ path: string; files: number; bytes: number }>;
    expectedFiles?: Array<{ path: string; size: number; modifiedAt: number | null }>;
    rollbackHint?: string;
  };
};

type MoveSuggestion = {
  category: CategoryKey;
  folderCount: number;
  bytes: number;
  destination: string;
  sourceFolders: Array<{ path: string; bytes: number; files: number }>;
  yearBuckets: Array<{ year: string; files: number }>;
};

type PreviewableFile = {
  id?: number;
  path: string;
  name: string;
  folderPath: string;
  size: number;
  extension: string;
  category: CategoryKey;
  mediaKind: string;
  modifiedAt: number | null;
  hashMatchType?: string;
  confidence?: number;
};

type AppPage = "workspace" | "index";
type DuplicateSortKey = "cleanup" | "reclaimable" | "files" | "folders" | "confidence";
type DuplicateReviewFilters = {
  exactOnly: boolean;
  mediaKind: "all" | CategoryKey;
  minReclaimMb: string;
  folderContains: string;
  pathContains: string;
  confidence: "all" | "safe" | "medium" | "review";
  folderPair: { folderA: string; folderB: string } | null;
};

const initialDuplicateFilters: DuplicateReviewFilters = {
  exactOnly: false,
  mediaKind: "all",
  minReclaimMb: "",
  folderContains: "",
  pathContains: "",
  confidence: "all",
  folderPair: null,
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nativeJobRef = useRef<{ jobId: number; indexPath: string } | null>(null);
  const [scan, setScan] = useState<ScanState>(initialScanState);
  const [filter, setFilter] = useState<CategoryKey | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExtension, setSearchExtension] = useState("");
  const [searchMediaKind, setSearchMediaKind] = useState("");
  const [searchMinMb, setSearchMinMb] = useState("");
  const [searchMaxMb, setSearchMaxMb] = useState("");
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<NativeSearchResult[]>([]);
  const [currentIndexPath, setCurrentIndexPath] = useState<string | null>(null);
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  const [duplicateFiles, setDuplicateFiles] = useState<NativeDuplicateFile[]>([]);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<number | null>(null);
  const [duplicateComparePaths, setDuplicateComparePaths] = useState<Record<number, string[]>>({});
  const [retainedDuplicatePaths, setRetainedDuplicatePaths] = useState<Record<number, string>>({});
  const [savedIndexes, setSavedIndexes] = useState<NativeIndexEntry[]>([]);
  const [stagedActions, setStagedActions] = useState<StagedAction[]>([]);
  const [committingActions, setCommittingActions] = useState(false);
  const [activePage, setActivePage] = useState<AppPage>("workspace");
  const [nativeRuntime, setNativeRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("Browser preview");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showSuggestedMoves, setShowSuggestedMoves] = useState(true);
  const [showDetailGrid, setShowDetailGrid] = useState(true);
  const [showSimulation, setShowSimulation] = useState(true);
  const [showDuplicates, setShowDuplicates] = useState(true);
  const [showReviewQueue, setShowReviewQueue] = useState(true);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [duplicateSort, setDuplicateSort] = useState<DuplicateSortKey>("cleanup");
  const [duplicateFilters, setDuplicateFilters] = useState<DuplicateReviewFilters>(initialDuplicateFilters);
  const [batchDuplicateIds, setBatchDuplicateIds] = useState<number[]>([]);
  const isWindowsRuntime = useMemo(() => {
    return typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("windows");
  }, []);

  useEffect(() => {
    void isNativeRuntime().then((native) => {
      setNativeRuntime(native);
      setRuntimeMessage(native ? "Native index mode" : "Browser preview");
      if (native) {
        void refreshSavedIndexes();
      }
    });
  }, []);

  useEffect(() => {
    if (!nativeRuntime) return;

    let unlisten: (() => void) | null = null;
    void listenNativeJobEvents((event) => {
      void handleNativeJobEvent(event);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [nativeRuntime]);

  const sortedFolders = useMemo(() => {
    return [...scan.folders].sort((a, b) => b.bytes - a.bytes);
  }, [scan.folders]);
  const actionableStagedActions = useMemo(() => {
    return stagedActions.filter((action) => action.operation?.kind === "recycleFiles" && action.operation.removePaths.length > 0);
  }, [stagedActions]);
  const staleStagedDuplicateCount = useMemo(() => {
    return stagedActions.filter((action) => action.operation?.kind === "recycleFiles" && action.evidence.some((item) => item.startsWith("Blocked:"))).length;
  }, [stagedActions]);
  const selectedDuplicateCandidate = useMemo(() => {
    return scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup) ?? null;
  }, [scan.duplicateCandidates, selectedDuplicateGroup]);
  const filteredDuplicateCandidates = useMemo(() => {
    return scan.duplicateCandidates.filter((candidate) => {
      const confidenceScore = candidate.confidenceScore ?? 0;
      const folderPaths = candidate.folderPaths ?? [];
      const minReclaimBytes = Number(duplicateFilters.minReclaimMb || 0) * 1024 * 1024;

      if (duplicateFilters.exactOnly && confidenceScore !== 1) return false;
      if (duplicateFilters.mediaKind !== "all" && categoryFromMediaKind(candidate.dominantMediaKind ?? "other") !== duplicateFilters.mediaKind) return false;
      if (minReclaimBytes > 0 && candidate.reclaimableBytes < minReclaimBytes) return false;
      if (duplicateFilters.folderContains.trim()) {
        const needle = duplicateFilters.folderContains.trim().toLowerCase();
        if (!folderPaths.some((path) => path.toLowerCase().includes(needle))) return false;
      }
      if (duplicateFilters.pathContains.trim()) {
        const needle = duplicateFilters.pathContains.trim().toLowerCase();
        if (!folderPaths.some((path) => path.toLowerCase().includes(needle))) return false;
      }
      if (duplicateFilters.confidence === "safe" && confidenceScore !== 1) return false;
      if (duplicateFilters.confidence === "medium" && (confidenceScore < 0.65 || confidenceScore >= 1)) return false;
      if (duplicateFilters.confidence === "review" && confidenceScore >= 0.65) return false;
      if (duplicateFilters.folderPair) {
        const { folderA, folderB } = duplicateFilters.folderPair;
        if (!folderPaths.includes(folderA) || !folderPaths.includes(folderB)) return false;
      }

      return true;
    });
  }, [duplicateFilters, scan.duplicateCandidates]);
  const sortedDuplicateCandidates = useMemo(() => {
    return [...filteredDuplicateCandidates].sort((a, b) => {
      if (duplicateSort === "reclaimable") return b.reclaimableBytes - a.reclaimableBytes;
      if (duplicateSort === "files") return b.files - a.files || b.reclaimableBytes - a.reclaimableBytes;
      if (duplicateSort === "folders") return (b.folderCount ?? 0) - (a.folderCount ?? 0) || b.reclaimableBytes - a.reclaimableBytes;
      if (duplicateSort === "confidence") return (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0) || b.reclaimableBytes - a.reclaimableBytes;
      return (b.cleanupScore ?? b.reclaimableBytes) - (a.cleanupScore ?? a.reclaimableBytes);
    });
  }, [duplicateSort, filteredDuplicateCandidates]);
  const exactBatchCandidates = useMemo(() => {
    return sortedDuplicateCandidates.filter((candidate) => candidate.id && candidate.confidenceScore === 1);
  }, [sortedDuplicateCandidates]);
  const duplicatePreviewFiles = useMemo(() => {
    return duplicateFiles.map((file): PreviewableFile => {
      const extension = file.extension ?? getExtension(file.name);
      return {
        id: file.id,
        path: file.path,
        name: file.name,
        folderPath: file.folder_path,
        size: file.size,
        extension,
        category: categoryFromMediaKind(file.media_kind),
        mediaKind: file.media_kind,
        modifiedAt: file.modified_at,
        hashMatchType: file.hash_match_type,
        confidence: file.confidence,
      };
    });
  }, [duplicateFiles]);
  const duplicateFolderRelationship = useMemo(() => {
    return buildDuplicateFolderRelationship(duplicateFiles);
  }, [duplicateFiles]);
  const duplicateKeepSuggestion = useMemo(() => {
    return suggestDuplicateKeepFile(duplicateFiles);
  }, [duplicateFiles]);
  const duplicateComparisonFiles = useMemo(() => {
    if (!selectedDuplicateGroup) return [];
    const paths = duplicateComparePaths[selectedDuplicateGroup] ?? duplicatePreviewFiles.slice(0, 2).map((file) => file.path);
    return paths
      .map((path) => duplicatePreviewFiles.find((file) => file.path === path))
      .filter((file): file is PreviewableFile => Boolean(file))
      .slice(0, 2);
  }, [duplicateComparePaths, duplicatePreviewFiles, selectedDuplicateGroup]);

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

  const selectedFolderPreview = selectedFolders.slice(0, 6);
  const remainingSelectedFolders = Math.max(0, selectedFolders.length - selectedFolderPreview.length);

  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    const hasAdvancedFilter = searchExtension.trim() || searchMediaKind || searchMinMb.trim() || searchMaxMb.trim() || searchRegex;
    if (trimmedQuery.length < 2 && !hasAdvancedFilter) {
      setSearchResults([]);
      return;
    }

    if (!nativeRuntime || !currentIndexPath) {
      const browserMatches = scan.largestFiles
        .filter((file) => {
          const matchesText = trimmedQuery.length < 2 || file.path.toLowerCase().includes(trimmedQuery.toLowerCase());
          const matchesExtension = !searchExtension.trim() || file.extension === searchExtension.trim().replace(/^\./, "").toLowerCase();
          const matchesMedia = !searchMediaKind || mediaKindFromCategory(file.category) === searchMediaKind;
          const minBytes = parseMegabytes(searchMinMb);
          const maxBytes = parseMegabytes(searchMaxMb);
          const matchesMin = minBytes == null || file.bytes >= minBytes;
          const matchesMax = maxBytes == null || file.bytes <= maxBytes;
          return matchesText && matchesExtension && matchesMedia && matchesMin && matchesMax;
        })
        .slice(0, 24)
        .map((file) => ({
          path: file.path,
          name: file.name,
          size: file.bytes,
          extension: file.extension,
          media_kind: mediaKindFromCategory(file.category),
          modified_at: file.modified || null,
        }));
      setSearchResults(browserMatches);
      return;
    }

    const handle = window.setTimeout(() => {
      void searchNativeIndex(currentIndexPath, trimmedQuery, 100, {
        extension: searchExtension,
        mediaKind: searchMediaKind,
        minSize: parseMegabytes(searchMinMb) ?? undefined,
        maxSize: parseMegabytes(searchMaxMb) ?? undefined,
        regex: searchRegex,
      })
        .then(setSearchResults)
        .catch((error) => {
          setRuntimeMessage(error instanceof Error ? error.message : "Search failed");
          setSearchResults([]);
        });
    }, 180);

    return () => window.clearTimeout(handle);
  }, [currentIndexPath, nativeRuntime, scan.largestFiles, searchExtension, searchMaxMb, searchMediaKind, searchMinMb, searchQuery, searchRegex]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = isEditableShortcutTarget(target);
      const hasModifier = event.altKey || event.ctrlKey || event.metaKey;
      if (hasModifier) return;
      if (isTyping && event.key !== "Escape") return;

      if (event.key === "/") {
        event.preventDefault();
        setActivePage("workspace");
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setFocusedFolder(null);
        setSelectedFolders([]);
        setSelectionMode(false);
        setShowShortcutHelp(false);
        searchInputRef.current?.blur();
        return;
      }

      if (event.key === "?" || event.key.toLowerCase() === "h") {
        event.preventDefault();
        setShowShortcutHelp((current) => !current);
        return;
      }

      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        setActivePage("index");
        return;
      }

      if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        setActivePage("workspace");
        return;
      }

      const filterKeys: Array<CategoryKey | "all"> = ["all", "photos", "videos", "music", "documents", "archives", "code", "installers", "models", "other"];
      const filterIndex = event.key === "0" ? 9 : Number(event.key) - 1;
      if (Number.isInteger(filterIndex) && filterIndex >= 0 && filterIndex < filterKeys.length) {
        event.preventDefault();
        setActivePage("workspace");
        setFilter(filterKeys[filterIndex]);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const metrics = [
    { label: "Indexed", value: formatCount(scan.processedFiles), detail: `${formatCount(scan.totalFiles)} selected` },
    { label: "Scanned", value: formatBytes(scan.processedBytes), detail: `${formatBytes(scan.totalBytes)} discovered` },
    { label: "Throughput", value: `${Math.round(scan.processedFiles / Math.max(scan.elapsedMs / 1000, 1))}/s`, detail: scan.status },
    { label: "Folders", value: formatCount(scan.folders.length), detail: scan.rootName },
  ];

  function openFolderPicker() {
    if (nativeRuntime) {
      void startNativeFolderScan();
      return;
    }

    const input = fileInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.click();
  }

  async function startNativeFolderScan() {
    try {
      const folder = await chooseNativeFolder();
      if (!folder) return;

      stopWorker();
      setFilter("all");
      setFocusedFolder(null);
      setSearchQuery("");
      setSearchResults([]);
      setCurrentIndexPath(null);
      setDuplicateFiles([]);
      setSelectedDuplicateGroup(null);
      setRuntimeMessage("Native scan starting");
      setScan({
        ...initialScanState,
        status: "scanning",
        rootName: lastSegment(folder) || folder,
        startedAt: performance.now(),
        currentPath: folder,
      });

      const { jobId, indexPath } = await startNativeScan(folder);
      nativeJobRef.current = { jobId, indexPath };
      setRuntimeMessage("Native index mode");
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Native scan failed");
      setScan((current) => ({ ...current, status: "cancelled" }));
    }
  }

  async function handleNativeJobEvent(event: NativeJobEvent) {
    if (nativeJobRef.current?.jobId !== event.job_id) return;

    if (event.status === "Failed") {
      setRuntimeMessage(event.message);
    } else if (event.message === "finalizing index") {
      setRuntimeMessage("Finalizing index");
    }

    setScan((current) => ({
      ...current,
      status: event.status === "Completed" ? "complete" : event.status === "Cancelled" ? "cancelled" : "scanning",
      processedFiles: event.files_scanned,
      totalFiles: Math.max(current.totalFiles, event.files_scanned),
      processedBytes: event.bytes_scanned,
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
      void refreshSavedIndexes();
      return;
    }

    if (event.status === "Cancelled" || event.status === "Failed") {
      nativeJobRef.current = null;
    }
  }

  function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    stopWorker();
    setFilter("all");
    setFocusedFolder(null);
    setSearchQuery("");
    setSearchResults([]);
    setCurrentIndexPath(null);
    setDuplicateFiles([]);
    setSelectedDuplicateGroup(null);
    setScan({
      ...initialScanState,
      status: "scanning",
      rootName: "Preparing scan...",
      totalFiles: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      startedAt: performance.now(),
    });

    const worker = new Worker(new URL("./scanWorker.ts", import.meta.url), { type: "module" });
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
  }

  function pauseScan() {
    postWorker(workerRef.current, { type: "pause" });
    setScan((current) => ({ ...current, status: "paused" }));
  }

  function resumeScan() {
    postWorker(workerRef.current, { type: "resume" });
    setScan((current) => ({ ...current, status: "scanning" }));
  }

  function cancelScan() {
    if (nativeJobRef.current) {
      void cancelNativeScan(nativeJobRef.current.jobId);
      return;
    }

    postWorker(workerRef.current, { type: "cancel" });
  }

  function clearScan() {
    stopWorker();
    nativeJobRef.current = null;
    setFilter("all");
    setFocusedFolder(null);
    setSearchQuery("");
    setSearchResults([]);
    setCurrentIndexPath(null);
    setDuplicateFiles([]);
    setSelectedDuplicateGroup(null);
    setScan(initialScanState);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function stopWorker() {
    workerRef.current?.terminate();
    workerRef.current = null;
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar" id="dashboard">
          <div>
            <div className="brand inline-brand">
              <img src={logoUrl} alt="" />
              <span>Birds Eye</span>
            </div>
            <p className="eyebrow">Offline storage intelligence</p>
            <h1>Understand where your disk space went.</h1>
          </div>
          <div className="action-row">
            <nav className="top-nav" aria-label="Primary">
              <button className={activePage === "workspace" ? "active" : ""} type="button" onClick={() => setActivePage("workspace")}>
                Workspace
              </button>
              <button className={activePage === "index" ? "active" : ""} type="button" onClick={() => setActivePage("index")}>
                Index Library
              </button>
            </nav>
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              multiple
              onChange={(event) => handleFiles(event.currentTarget.files)}
            />
            <button className="primary-action icon-primary" type="button" onClick={openFolderPicker} title="Choose folder" aria-label="Choose folder">
              <FolderOpen size={18} />
            </button>
            {scan.status === "scanning" && (
              <button className="ghost-action" type="button" onClick={pauseScan} title="Pause scan" aria-label="Pause scan">
                <Pause size={18} />
              </button>
            )}
            {scan.status === "paused" && (
              <button className="ghost-action" type="button" onClick={resumeScan} title="Resume scan" aria-label="Resume scan">
                <Play size={18} />
              </button>
            )}
            {(scan.status === "scanning" || scan.status === "paused") && (
              <button className="ghost-action danger" type="button" onClick={cancelScan} title="Cancel scan" aria-label="Cancel scan">
                <Square size={16} />
              </button>
            )}
            {scan.status !== "idle" && (
              <button className="ghost-action" type="button" onClick={clearScan} title="Clear results" aria-label="Clear results">
                <Trash2 size={18} />
              </button>
            )}
            <button
              className={`ghost-action ${showShortcutHelp ? "active" : ""}`}
              type="button"
              onClick={() => setShowShortcutHelp((current) => !current)}
              title="Keyboard shortcuts"
              aria-label="Keyboard shortcuts"
              aria-expanded={showShortcutHelp}
            >
              <Keyboard size={18} />
            </button>
          </div>
        </header>

        {activePage === "workspace" ? (
        <>
        <section className="scan-strip" id="scan" aria-label="Scan progress">
          <div>
            <span>{scan.rootName}</span>
            <strong>{scan.status === "idle" ? "Ready" : scan.status}</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${getProgress(scan)}%` }} />
          </div>
          <small>{runtimeMessage} - {scan.currentPath}</small>
        </section>

        <section className="metric-grid" aria-label="Scan metrics">
          {metrics.map((metric) => (
            <motion.article
              className="metric-card"
              key={metric.label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <small>{metric.detail}</small>
            </motion.article>
          ))}
        </section>

        <section className="filter-bar" aria-label="Category filters">
          <button className={filter === "all" ? "active" : ""} type="button" onClick={() => setFilter("all")}>
            All
          </button>
          {(Object.keys(categories) as CategoryKey[]).map((key) => (
            <button
              className={filter === key ? "active" : ""}
              key={key}
              type="button"
              onClick={() => setFilter(key)}
            >
              <span style={{ background: categories[key].color }} />
              {categories[key].label}
            </button>
          ))}
        </section>

        {showShortcutHelp && <ShortcutHelp />}

        <details className="layout-controls">
          <summary>Layout controls</summary>
          <div className="layout-toggles" role="group" aria-label="Workbench panel visibility">
            <button className={showDetailGrid ? "active" : ""} type="button" onClick={() => setShowDetailGrid((current) => !current)}>
              Detail grids
            </button>
            <button className={showSimulation ? "active" : ""} type="button" onClick={() => setShowSimulation((current) => !current)}>
              Simulation
            </button>
            <button className={showDuplicates ? "active" : ""} type="button" onClick={() => setShowDuplicates((current) => !current)}>
              Duplicates
            </button>
            <button className={showReviewQueue ? "active" : ""} type="button" onClick={() => setShowReviewQueue((current) => !current)}>
              Review queue
            </button>
          </div>
        </details>

        <section className="analysis-layout" id="treemap">
          <div className="treemap-panel">
            <div className="panel-header">
              <h2>Space Distribution</h2>
              <span>{focusedFolder ? lastSegment(focusedFolder) : filteredFolders.length > 0 ? "Largest folders by selected category" : "Select a folder to begin"}</span>
            </div>
            {focusedFolder && (
              <FocusedFolderSummary
                folder={scan.folders.find((folder) => folder.path === focusedFolder) ?? null}
                onReveal={(path) => void revealPath(path)}
              />
            )}
            {focusedFolder && (
              <div className="breadcrumb-row">
                <button type="button" onClick={() => setFocusedFolder(parentPath(focusedFolder))} title="Go up one folder">
                  <ChevronLeft size={16} />
                </button>
                <span>{focusedFolder}</span>
                <button type="button" onClick={() => setFocusedFolder(null)}>Root</button>
              </div>
            )}
            <div className="treemap-selection-bar">
              <button
                className={selectionMode ? "active" : ""}
                type="button"
                onClick={() => setSelectionMode((current) => !current)}
              >
                Batch select
              </button>
              <span>{selectedFolders.length > 0 ? `${formatCount(selectedFolders.length)} selected` : "Select multiple folders"}</span>
              {selectedFolders.length > 0 && (
                <button type="button" onClick={() => setSelectedFolders([])}>
                  Clear
                </button>
              )}
            </div>
            {selectedFolders.length > 0 && (
              <div className="treemap-selection-list">
                {selectedFolderPreview.map((path) => (
                  <span className="treemap-selection-chip" key={path} title={path}>
                    {lastSegment(path)}
                    <button type="button" onClick={() => toggleSelectedFolder(path)} aria-label={`Remove ${path}`}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
                {remainingSelectedFolders > 0 && (
                  <span className="treemap-selection-chip muted">+{formatCount(remainingSelectedFolders)} more</span>
                )}
              </div>
            )}
            <Treemap
              files={scan.largestFiles}
              folders={filteredFolders}
              nativeRuntime={nativeRuntime}
              onSelect={(folder) => {
                if (selectionMode) {
                  toggleSelectedFolder(folder.path);
                } else {
                  setFocusedFolder(folder.path);
                }
              }}
            />
            <details className="insight-disclosure">
              <summary>Hierarchy rings</summary>
              <SunburstHierarchy folders={scan.folders} onSelectFolder={(path) => setFocusedFolder(path)} />
            </details>
          </div>

          <aside className="recommendations">
            <div className="panel-header compact">
              <h2>Cleanup Signals</h2>
              <span>Toggle panels</span>
            </div>
            <div className="panel-toggles" role="group" aria-label="Cleanup panel visibility">
              <button className={showHeatmap ? "active" : ""} type="button" onClick={() => setShowHeatmap((current) => !current)}>
                Heatmap
              </button>
              <button className={showSuggestedMoves ? "active" : ""} type="button" onClick={() => setShowSuggestedMoves((current) => !current)}>
                Suggested moves
              </button>
            </div>
            {showHeatmap ? (
              <ActionHeatmap scan={scan} onStageAction={stageHeatmapAction} />
            ) : (
              <div className="empty-state compact">Action heatmap hidden. Toggle it back on to review cleanup signals.</div>
            )}
            {showSuggestedMoves ? (
              <SmartSuggestedMoves scan={scan} onStage={stageSuggestedMove} />
            ) : (
              <div className="empty-state compact">Suggested moves hidden. Toggle it back on to review move ideas.</div>
            )}
          </aside>
        </section>

        <section className="folder-table" id="data">
          <div className="panel-header">
            <h2>Largest Folders</h2>
            <span><Search size={14} /> {formatCount(sortedFolders.length)} folders</span>
          </div>
          {sortedFolders.length === 0 ? (
            <div className="empty-state">Choose a folder to generate the first storage intelligence snapshot.</div>
          ) : (
            <ScrollableRows>
              {sortedFolders.map((folder) => (
                <div className="folder-row action-row-grid" key={folder.path}>
                  <span>{folder.path}</span>
                  <strong>{formatBytes(folder.bytes)}</strong>
                  <small>{formatCount(folder.files)} files</small>
                  <IconButton title="Open in Explorer" onClick={() => void revealPath(folder.path)}>
                    <ExternalLink size={16} />
                  </IconButton>
                </div>
              ))}
            </ScrollableRows>
          )}
        </section>

        <section className="folder-table search-panel">
          <div className="panel-header">
            <h2>File Search</h2>
            <span><Search size={14} /> {formatCount(searchResults.length)} matches</span>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              placeholder={searchRegex ? "Regex search indexed paths" : "Search indexed paths"}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
          </label>
          <div className="search-filters">
            <input
              type="text"
              value={searchExtension}
              placeholder="Extension"
              onChange={(event) => setSearchExtension(event.currentTarget.value)}
            />
            <select value={searchMediaKind} onChange={(event) => setSearchMediaKind(event.currentTarget.value)}>
              <option value="">Any media</option>
              <option value="photo">Photos</option>
              <option value="video">Videos</option>
              <option value="music">Music</option>
              <option value="archive">Archives</option>
              <option value="document">Documents</option>
              <option value="code">Code</option>
              <option value="installer">Installers</option>
              <option value="model">AI Models</option>
              <option value="other">Other</option>
            </select>
            <input
              type="number"
              min="0"
              value={searchMinMb}
              placeholder="Min MB"
              onChange={(event) => setSearchMinMb(event.currentTarget.value)}
            />
            <input
              type="number"
              min="0"
              value={searchMaxMb}
              placeholder="Max MB"
              onChange={(event) => setSearchMaxMb(event.currentTarget.value)}
            />
            <label>
              <input type="checkbox" checked={searchRegex} onChange={(event) => setSearchRegex(event.currentTarget.checked)} />
              Regex
            </label>
          </div>
          {searchQuery.trim().length < 2 && !searchExtension.trim() && !searchMediaKind && !searchMinMb.trim() && !searchMaxMb.trim() && !searchRegex ? (
            <div className="empty-state compact">Enter at least two characters or choose a filter to search the current index.</div>
          ) : searchResults.length === 0 ? (
            <div className="empty-state compact">No indexed files match this search.</div>
          ) : (
            <ScrollableRows compact>
              {searchResults.map((file) => (
                <div className="folder-row file-row action-row-grid" key={file.path}>
                  <span>{file.path}</span>
                  <strong>{formatBytes(file.size)}</strong>
                  <small>{file.extension ?? "(none)"}</small>
                  <IconButton title="Open in Explorer" onClick={() => void revealPath(file.path)}>
                    <ExternalLink size={16} />
                  </IconButton>
                </div>
              ))}
            </ScrollableRows>
          )}
        </section>

        {showDetailGrid && (
          <section className="detail-grid">
            <div className="folder-table">
              <div className="panel-header">
                <h2>Largest Files</h2>
                <span>{formatCount(scan.largestFiles.length)} tracked</span>
              </div>
              {scan.largestFiles.length === 0 ? (
                <div className="empty-state compact">Largest files appear during the next scan.</div>
              ) : (
                <ScrollableRows compact>
                  {scan.largestFiles.map((file) => (
                    <div className="folder-row file-row action-row-grid" key={file.path}>
                      <span>{file.path}</span>
                      <strong>{formatBytes(file.bytes)}</strong>
                      <small>{file.extension}</small>
                      <IconButton title="Open in Explorer" onClick={() => void revealPath(file.path)}>
                        <ExternalLink size={16} />
                      </IconButton>
                    </div>
                  ))}
                </ScrollableRows>
              )}
            </div>

            <div className="folder-table">
              <div className="panel-header">
                <h2>Extensions</h2>
                <span>{formatCount(scan.extensions.length)} groups</span>
              </div>
              {scan.extensions.length === 0 ? (
                <div className="empty-state compact">Extension totals appear during the next scan.</div>
              ) : (
                <ScrollableRows compact>
                  {scan.extensions.map((extension) => (
                    <div className="folder-row extension-row" key={extension.extension}>
                      <span>.{extension.extension}</span>
                      <strong>{formatBytes(extension.bytes)}</strong>
                      <small>{formatCount(extension.files)} files</small>
                    </div>
                  ))}
                </ScrollableRows>
              )}
            </div>
          </section>
        )}

        <details className="insight-disclosure pinned-feature">
          <summary>Media timeline is pinned for repair</summary>
          <p>The timeline is currently parked while the rest of the cleanup workflow moves forward.</p>
          <TimelineScatter
            files={scan.largestFiles}
            nativeRuntime={nativeRuntime}
            onSelectFile={(file) => {
              setSearchQuery(file.path);
            }}
          />
        </details>

        {showSimulation && (
          <BeforeAfterSimulation
            candidates={scan.duplicateCandidates}
            files={scan.largestFiles}
            folders={scan.folders}
            nativeRuntime={nativeRuntime}
            overlaps={scan.duplicateOverlaps}
          />
        )}

        {showDuplicates && (
          <section className="folder-table">
            <div className="panel-header">
              <h2>Duplicate Candidates</h2>
              <span><CopyCheck size={14} /> Size + partial + full hash</span>
            </div>
            <DuplicateSummary candidates={scan.duplicateCandidates} overlaps={scan.duplicateOverlaps} />
            <DuplicateCleanupEdgeStates
              duplicateCount={scan.duplicateCandidates.length}
              nativeRuntime={nativeRuntime}
              isWindowsRuntime={isWindowsRuntime}
              staleStagedCount={staleStagedDuplicateCount}
              runtimeMessage={runtimeMessage}
            />
            <DuplicateReviewControls
              filters={duplicateFilters}
              resultCount={sortedDuplicateCandidates.length}
              sort={duplicateSort}
              onFiltersChange={setDuplicateFilters}
              onSortChange={setDuplicateSort}
            />
            {scan.duplicateOverlaps.length > 0 && (
              <FolderPairDuplicateSummary
                overlaps={scan.duplicateOverlaps}
                activePair={duplicateFilters.folderPair}
                onReviewPair={(pair) => setDuplicateFilters((current) => ({ ...current, folderPair: pair }))}
              />
            )}
            {scan.duplicateOverlaps.length > 0 && (
              <details className="insight-disclosure">
                <summary>Folder overlap map</summary>
                <DuplicateOverlapGraph overlaps={scan.duplicateOverlaps} onSelectFolder={(path) => setFocusedFolder(path)} />
              </details>
            )}
            {exactBatchCandidates.length > 0 && (
              <ExactDuplicateBatchReview
                candidates={exactBatchCandidates}
                selectedIds={batchDuplicateIds}
                onSelectedIdsChange={setBatchDuplicateIds}
                onStageSelected={() => void stageSelectedExactDuplicateBatch()}
              />
            )}
            {scan.duplicateCandidates.length === 0 ? (
              <div className="empty-state compact">Files with identical sizes will appear here as duplicate candidates.</div>
            ) : sortedDuplicateCandidates.length === 0 ? (
              <div className="empty-state compact">No duplicate groups match the current filters.</div>
            ) : (
              <div className="duplicate-candidates">
                <div className="duplicate-candidate-list">
                  <ScrollableRows compact>
                    <div className="duplicate-list-header" aria-hidden="true">
                      <span>Group</span>
                      <span>Reclaim</span>
                      <span>Confidence</span>
                      <span>Review</span>
                    </div>
                    {sortedDuplicateCandidates.map((candidate) => (
                      <div
                        className={`duplicate-row ${selectedDuplicateGroup === candidate.id ? "active" : ""}`}
                        key={candidate.id ?? candidate.size}
                        onClick={() => void selectDuplicateCandidate(candidate)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            void selectDuplicateCandidate(candidate);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div>
                          <strong>{candidate.confidenceScore === 1 ? "Exact duplicate group" : "Review duplicate group"}</strong>
                          <span>
                            {formatCount(candidate.files)} copies, {formatCount(candidate.folderCount ?? 1)} folders, {mediaKindLabel(candidate.dominantMediaKind)} - {formatBytes(candidate.size)} each
                          </span>
                        </div>
                        <strong>{formatBytes(candidate.reclaimableBytes)}</strong>
                        <small className={`confidence-pill ${candidate.confidenceScore === 1 ? "safe" : "medium"}`}>
                          {candidate.confidenceScore === 1 ? "Safe" : `${Math.round((candidate.confidenceScore ?? 0) * 100)}%`}
                        </small>
                        <span className="duplicate-actions">
                          <IconButton title="Stage exact duplicate review" onClick={(event) => void stageDuplicateAction(candidate, event)}>
                            <CopyCheck size={16} />
                          </IconButton>
                        </span>
                      </div>
                    ))}
                  </ScrollableRows>
                </div>
                <div className="duplicate-detail-panel">
                  {selectedDuplicateCandidate ? (
                    <>
                      <div className="duplicate-detail-header">
                        <div>
                          <strong>{selectedDuplicateCandidate.confidenceScore === 1 ? "Exact duplicate group" : "Review duplicate group"}</strong>
                          <span>{formatCount(selectedDuplicateCandidate.files)} copies, {formatBytes(selectedDuplicateCandidate.size)} each</span>
                        </div>
                        <div className="duplicate-detail-actions">
                          <small className={`confidence-pill ${selectedDuplicateCandidate.confidenceScore === 1 ? "safe" : "medium"}`}>
                            {selectedDuplicateCandidate.confidenceScore === 1 ? "Safe" : `${Math.round((selectedDuplicateCandidate.confidenceScore ?? 0) * 100)}%`}
                          </small>
                          <IconButton title="Stage this duplicate review" onClick={() => void stageDuplicateAction(selectedDuplicateCandidate)}>
                            <CopyCheck size={16} />
                          </IconButton>
                          <IconButton title="Refresh duplicate group" onClick={() => void refreshSelectedDuplicateGroup()}>
                            <RotateCw size={16} />
                          </IconButton>
                        </div>
                      </div>
                      <div className="duplicate-detail-metrics">
                        <div>
                          <span>Reclaimable</span>
                          <strong>{formatBytes(selectedDuplicateCandidate.reclaimableBytes)}</strong>
                        </div>
                        <div>
                          <span>Group id</span>
                          <strong>{selectedDuplicateCandidate.id ?? formatBytes(selectedDuplicateCandidate.size)}</strong>
                        </div>
                        <div>
                          <span>Folders</span>
                          <strong>{formatCount(selectedDuplicateCandidate.folderCount ?? 1)}</strong>
                        </div>
                        <div>
                          <span>Media type</span>
                          <strong>{mediaKindLabel(selectedDuplicateCandidate.dominantMediaKind)}</strong>
                        </div>
                      </div>
                      {duplicateFolderRelationship && (
                        <div className="duplicate-folder-summary">
                          <div>
                            <strong>This duplicate appears in {formatCount(duplicateFolderRelationship.folderCount)} folders.</strong>
                            <span>{duplicateFolderRelationship.message}</span>
                          </div>
                          <div className="duplicate-folder-pairs">
                            <div>
                              <span>Likely source</span>
                              <strong title={duplicateFolderRelationship.likelySource.path}>{lastSegment(duplicateFolderRelationship.likelySource.path)}</strong>
                              <small>{formatCount(duplicateFolderRelationship.likelySource.files)} copies - {formatBytes(duplicateFolderRelationship.likelySource.bytes)}</small>
                            </div>
                            <div>
                              <span>Likely duplicate</span>
                              <strong title={duplicateFolderRelationship.likelyDuplicate.path}>{lastSegment(duplicateFolderRelationship.likelyDuplicate.path)}</strong>
                              <small>{formatCount(duplicateFolderRelationship.likelyDuplicate.files)} copies - {formatBytes(duplicateFolderRelationship.likelyDuplicate.bytes)}</small>
                            </div>
                          </div>
                          <div className="duplicate-folder-breakdown">
                            {duplicateFolderRelationship.folders.map((folder) => (
                              <div key={folder.path}>
                                <span title={folder.path}>{folder.path}</span>
                                <strong>{formatCount(folder.files)} copies</strong>
                                <small>{formatBytes(folder.bytes)}</small>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {duplicateKeepSuggestion && (
                        <div className="duplicate-keep-suggestion">
                          <div>
                            <span>Suggested keep</span>
                            <strong title={duplicateKeepSuggestion.file.path}>{duplicateKeepSuggestion.file.path}</strong>
                            <small>{duplicateKeepSuggestion.reason}</small>
                          </div>
                          <IconButton
                            title="Use suggested retained copy"
                            onClick={() => chooseDuplicateRetainedCopy({
                              path: duplicateKeepSuggestion.file.path,
                              name: duplicateKeepSuggestion.file.name,
                            })}
                          >
                            <Check size={16} />
                          </IconButton>
                        </div>
                      )}
                      <DuplicateComparisonPanel
                        files={duplicateComparisonFiles}
                        exact={selectedDuplicateCandidate.confidenceScore === 1}
                        nativeRuntime={nativeRuntime}
                      />
                      <div className="duplicate-detail-files">
                        {duplicatePreviewFiles.length === 0 ? (
                          <div className="empty-state compact">Select this group again to load file details.</div>
                        ) : (
                          <FilePreviewWorkbench
                            files={duplicatePreviewFiles}
                            nativeRuntime={nativeRuntime}
                            emptyLabel="Select a duplicate copy"
                            statusForFile={(file) => duplicateFileStatus(file)}
                            renderFileActions={(file, preview) => (
                              <>
                                <IconButton title="Preview this copy" onClick={(event) => {
                                  event.stopPropagation();
                                  preview();
                                }}>
                                  <Eye size={16} />
                                </IconButton>
                                <IconButton
                                  disabled={!canChooseSelectedDuplicateKeep()}
                                  title="Keep this copy"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    chooseDuplicateRetainedCopy(file);
                                  }}
                                >
                                  <Check size={16} />
                                </IconButton>
                                <IconButton title="Reveal in Explorer" onClick={(event) => {
                                  event.stopPropagation();
                                  void revealPath(file.path);
                                }}>
                                  <ExternalLink size={16} />
                                </IconButton>
                                <IconButton title="Compare this copy" onClick={(event) => {
                                  event.stopPropagation();
                                  toggleDuplicateComparison(file);
                                }}>
                                  <Square size={16} />
                                </IconButton>
                                <IconButton
                                  disabled={!canStageSelectedDuplicateKeep()}
                                  title="Stage deletion of other copies"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    stageSelectedDuplicateKeep(file);
                                  }}
                                >
                                  <CopyCheck size={16} />
                                </IconButton>
                              </>
                            )}
                          />
                        )}
                        {selectedDuplicateCandidate.files > duplicateFiles.length && (
                          <span className="duplicate-detail-footnote">
                            Showing {formatCount(duplicateFiles.length)} of {formatCount(selectedDuplicateCandidate.files)} files.
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="empty-state compact">Select a duplicate group to review its files.</div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {showReviewQueue && (
          <section className="folder-table">
            <div className="panel-header">
              <h2>Review Queue</h2>
              <span>{formatCount(stagedActions.length)} staged reviews</span>
            </div>
            {stagedActions.length === 0 ? (
              <div className="empty-state compact">No staged reviews. Add duplicate groups here first; no files are changed from this queue.</div>
            ) : (
              <>
                <div className="stage-summary">
                  <strong>{formatBytes(stagedActions.reduce((sum, action) => sum + action.bytes, 0))}</strong>
                  <span>reclaimable if committed later</span>
                  <IconButton title="Undo last staged action" onClick={() => setStagedActions((current) => current.slice(0, -1))}>
                    <Undo2 size={16} />
                  </IconButton>
                  <IconButton title="Clear staged actions" onClick={() => setStagedActions([])}>
                    <X size={16} />
                  </IconButton>
                  <IconButton
                    className="danger-text"
                    disabled={!nativeRuntime || !isWindowsRuntime || committingActions || actionableStagedActions.length === 0}
                    title={isWindowsRuntime ? "Commit safe recycle actions" : "Recycle Bin commits are Windows-only"}
                    onClick={() => void commitStagedActions()}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
                <ScrollableRows compact>
                  {stagedActions.map((action) => (
                    <div className="staged-row" key={action.id}>
                      <div className="staged-main">
                        <strong>{action.label}</strong>
                        <span>{action.reason}</span>
                        <div className="why-panel">
                          <small>Why this suggestion?</small>
                          {action.evidence.map((item) => (
                            <span key={item}>{item}</span>
                          ))}
                          <strong>{action.suggestedAction}</strong>
                        </div>
                        {action.operation?.kind === "recycleFiles" && (
                          <StagedDuplicateAudit action={action} />
                        )}
                      </div>
                      <small className={`confidence-pill ${confidenceClass(action.confidence)}`}>{action.confidence}</small>
                      <strong>{formatBytes(action.bytes)}</strong>
                    </div>
                  ))}
                </ScrollableRows>
              </>
            )}
          </section>
        )}
        </>
        ) : (
        <section className="folder-table" id="index-library">
          <div className="panel-header">
            <h2>Index Library</h2>
            <span><Database size={14} /> {nativeRuntime ? `${formatCount(savedIndexes.length)} local indexes` : "Desktop app only"}</span>
          </div>
          {!nativeRuntime ? (
            <div className="empty-state compact">Local indexes are available in the desktop app.</div>
          ) : savedIndexes.length === 0 ? (
            <div className="empty-state compact">Scanned folders will appear here for revisiting, rescanning, or removing their local index.</div>
          ) : (
            <>
              <div className="index-summary-grid">
                <div>
                  <span>Total indexed</span>
                  <strong>{formatBytes(savedIndexes.reduce((sum, entry) => sum + entry.bytes_scanned, 0))}</strong>
                </div>
                <div>
                  <span>Files tracked</span>
                  <strong>{formatCount(savedIndexes.reduce((sum, entry) => sum + entry.files_scanned, 0))}</strong>
                </div>
                <div>
                  <span>Latest scan</span>
                  <strong>{formatIndexDate(savedIndexes[0]?.last_scanned_at)}</strong>
                </div>
              </div>
              <ScrollableRows compact>
                {savedIndexes.map((entry) => (
                  <div className={`index-row ${currentIndexPath === entry.index_path ? "active" : ""}`} key={entry.index_path}>
                    <div>
                      <strong>{entry.root_path ?? "Unknown root"}</strong>
                      <span>{entry.index_path}</span>
                      <div className="index-meta">
                        <small>{entry.last_status ?? "unknown"}</small>
                        <small>{formatIndexDate(entry.last_scanned_at)}</small>
                        <small>{formatBytes(entry.bytes_scanned)}</small>
                        <small>{formatCount(entry.files_scanned)} files</small>
                      </div>
                    </div>
                    <div className="index-actions">
                      <IconButton title="View saved index" onClick={() => void openSavedIndex(entry)}>
                        <Eye size={16} />
                      </IconButton>
                      <IconButton title="Rescan folder" onClick={() => void rescanSavedIndex(entry)}>
                        <RotateCw size={16} />
                      </IconButton>
                      <IconButton className="danger-text" title="Delete saved index" onClick={() => void removeSavedIndex(entry)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </ScrollableRows>
            </>
          )}
        </section>
        )}
      </section>
    </main>
  );

  async function selectDuplicateCandidate(candidate: ScanState["duplicateCandidates"][number]) {
    setSelectedDuplicateGroup(candidate.id ?? null);
    setDuplicateFiles([]);
    if (!candidate.id || !currentIndexPath) {
      return;
    }

    try {
      const files = await queryNativeDuplicateFiles(currentIndexPath, candidate.id, Math.max(candidate.files, 24));
      setDuplicateFiles(files);
      rememberRetainedDuplicatePath(candidate.id, files);
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Duplicate details failed");
    }
  }

  async function revealPath(path: string) {
    if (!nativeRuntime) {
      setRuntimeMessage("Open in Explorer is available in the desktop app");
      return;
    }

    try {
      await revealNativePath(path);
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Failed to open path");
    }
  }

  async function refreshSelectedDuplicateGroup() {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    if (!candidate?.id || !currentIndexPath) {
      setRuntimeMessage("Choose a saved duplicate group before refreshing it");
      return;
    }

    try {
      const refresh = await refreshNativeDuplicateGroup(currentIndexPath, candidate.id, Math.max(candidate.files, 24));
      const overview = await queryNativeIndex(currentIndexPath, 1000);
      setScan((current) => mergeNativeOverview(current, overview));
      if (refresh.group) {
        setSelectedDuplicateGroup(refresh.group.id);
        setDuplicateFiles(refresh.files);
        rememberRetainedDuplicatePath(refresh.group.id, refresh.files);
        setRuntimeMessage(`Refreshed duplicate group: ${formatCount(refresh.refreshed)} checked, ${formatCount(refresh.deleted)} missing`);
      } else {
        setSelectedDuplicateGroup(null);
        setDuplicateFiles([]);
        setRuntimeMessage(`Duplicate group no longer exists after refresh. ${formatCount(refresh.deleted)} missing copy marked stale.`);
      }
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Failed to refresh duplicate group");
    }
  }

  async function stageDuplicateAction(candidate: ScanState["duplicateCandidates"][number], event?: React.MouseEvent) {
    event?.stopPropagation();
    const confidenceScore = candidate.confidenceScore ?? 0;
    const confidence = confidenceScore >= 1 ? "Safe" : confidenceScore >= 0.65 ? "Medium" : "Manual review";
    const id = `duplicate-${candidate.id ?? candidate.size}`;
    let operation: StagedAction["operation"];

    if (confidenceScore >= 1 && candidate.id && currentIndexPath) {
      try {
        const files = await queryNativeDuplicateFiles(currentIndexPath, candidate.id, Math.max(candidate.files, 1000));
        setSelectedDuplicateGroup(candidate.id);
        setDuplicateFiles(files.slice(0, 24));
        rememberRetainedDuplicatePath(candidate.id, files);
        const keepFile = suggestDuplicateKeepFile(files)?.file;
        if (keepFile) {
          const nextOperation = buildDuplicateRecycleOperation(candidate.id, files, keepFile.path);
          if (nextOperation.removePaths.length > 0) {
            operation = nextOperation;
          }
        }
      } catch (error) {
        setRuntimeMessage(error instanceof Error ? error.message : "Duplicate details failed");
      }
    }

    setStagedActions((current) => {
      if (current.some((action) => action.id === id)) return current;
      return [
        ...current,
        {
          id,
          label: confidenceScore >= 1 ? "Exact duplicate cleanup candidate" : "Duplicate review candidate",
          confidence,
          bytes: candidate.reclaimableBytes,
          reason: confidenceScore >= 1
            ? `Group ${candidate.id ?? formatBytes(candidate.size)} has matching full-file hashes. This is staged only.`
            : `Group ${candidate.id ?? formatBytes(candidate.size)} needs manual review before cleanup.`,
          suggestedAction: operation
            ? `Keep ${lastSegment(operation.keepPath)} and move ${formatCount(operation.removePaths.length)} duplicate copies to the Recycle Bin on commit.`
            : confidenceScore >= 1
              ? "Review copies and choose retained files before committing cleanup."
              : "Inspect matching candidates before choosing which copy should stay.",
          evidence: [
            candidate.id ? `Duplicate group: ${candidate.id}.` : "Duplicate group id unavailable.",
            `${formatCount(candidate.files)} files share the same ${formatBytes(candidate.size)} size.`,
            confidenceScore >= 1 ? "Full-file hashes match across this group." : "This group has not reached exact-hash confidence.",
            `${formatBytes(candidate.reclaimableBytes)} is potentially reclaimable after keeping one copy.`,
            operation ? `Retained copy: ${operation.keepPath}` : "No file operation is attached to this staged review yet.",
            operation ? `Retained file id: ${operation.keepFileId ?? "unknown"}.` : "Retained file id unavailable until a copy is selected.",
            operation ? `Files to recycle: ${operation.removeFileIds?.join(", ") || "none"}.` : "Deleted file ids unavailable until a copy is selected.",
            operation?.rollbackHint ?? "Recycle Bin rollback metadata unavailable until staging has a file operation.",
          ],
          operation,
        },
      ];
    });
  }

  async function stageSelectedExactDuplicateBatch() {
    const selected = exactBatchCandidates.filter((candidate) => candidate.id && batchDuplicateIds.includes(candidate.id));
    if (selected.length === 0) {
      setRuntimeMessage("Select exact duplicate groups before staging a batch");
      return;
    }

    for (const candidate of selected) {
      await stageDuplicateAction(candidate);
    }
    setBatchDuplicateIds([]);
    setRuntimeMessage(`Staged ${formatCount(selected.length)} exact duplicate groups for review`);
  }

  function canStageSelectedDuplicateKeep() {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    return Boolean(candidate?.id && candidate.confidenceScore === 1 && duplicateFiles.length > 1);
  }

  function canChooseSelectedDuplicateKeep() {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    return Boolean(candidate?.id && duplicateFiles.length > 1);
  }

  function chooseDuplicateRetainedCopy(keepFile: Pick<PreviewableFile, "path" | "name">) {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    if (!candidate?.id || duplicateFiles.length <= 1) {
      setRuntimeMessage("Choose a duplicate group before selecting the retained copy");
      return;
    }

    const groupId = candidate.id;
    setRetainedDuplicatePaths((current) => ({ ...current, [groupId]: keepFile.path }));
    setStagedActions((current) => current.map((action) => {
      if (action.id !== `duplicate-${groupId}` || action.operation?.kind !== "recycleFiles") {
        return action;
      }

      const operation = buildDuplicateRecycleOperation(groupId, duplicateFiles, keepFile.path);
      return {
        ...action,
        suggestedAction: `Keep ${lastSegment(keepFile.path)} and move ${formatCount(operation.removePaths.length)} duplicate copies to the Recycle Bin on commit.`,
        evidence: [
          `Duplicate group: ${groupId}.`,
          `${formatCount(candidate.files)} files share the same ${formatBytes(candidate.size)} size.`,
          "Full-file hashes match across this group.",
          `Retained copy: ${keepFile.path}`,
          `Retained file id: ${operation.keepFileId ?? "unknown"}.`,
          `Files to recycle: ${operation.removeFileIds?.join(", ") || "none"}.`,
          `${formatBytes(candidate.reclaimableBytes)} is potentially reclaimable after keeping one copy.`,
          operation.rollbackHint ?? "Recycle Bin rollback metadata unavailable.",
        ],
        operation,
      };
    }));
    setRuntimeMessage(`Marked ${keepFile.name} as the retained copy for this duplicate group`);
  }

  function toggleDuplicateComparison(file: Pick<PreviewableFile, "path" | "name">) {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    if (!candidate?.id) {
      setRuntimeMessage("Choose a duplicate group before comparing copies");
      return;
    }

    const groupId = candidate.id;
    setDuplicateComparePaths((current) => {
      const existing = current[groupId] ?? duplicatePreviewFiles.slice(0, 2).map((previewFile) => previewFile.path);
      const next = existing.includes(file.path)
        ? existing.filter((path) => path !== file.path)
        : [...existing, file.path].slice(-2);

      return { ...current, [groupId]: next };
    });
    setRuntimeMessage(`Comparison updated with ${file.name}`);
  }

  function stageSelectedDuplicateKeep(keepFile: Pick<PreviewableFile, "path">) {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    if (!candidate?.id || candidate.confidenceScore !== 1 || duplicateFiles.length <= 1) {
      setRuntimeMessage("Choose an exact duplicate group before selecting the retained copy");
      return;
    }

    const id = `duplicate-${candidate.id ?? candidate.size}`;
    const groupId = candidate.id;
    const operation = buildDuplicateRecycleOperation(groupId, duplicateFiles, keepFile.path);
    setRetainedDuplicatePaths((current) => ({ ...current, [groupId]: keepFile.path }));

    setStagedActions((current) => {
      const nextAction: StagedAction = {
        id,
        label: "Exact duplicate cleanup candidate",
        confidence: "Safe",
        bytes: candidate.reclaimableBytes,
        reason: `Group ${candidate.id ?? formatBytes(candidate.size)} has matching full-file hashes. You chose the retained copy.`,
        suggestedAction: `Keep ${lastSegment(keepFile.path)} and move ${formatCount(operation.removePaths.length)} duplicate copies to the Recycle Bin on commit.`,
        evidence: [
          `Duplicate group: ${groupId}.`,
          `${formatCount(candidate.files)} files share the same ${formatBytes(candidate.size)} size.`,
          "Full-file hashes match across this group.",
          `Retained copy: ${keepFile.path}`,
          `Retained file id: ${operation.keepFileId ?? "unknown"}.`,
          `Files to recycle: ${operation.removeFileIds?.join(", ") || "none"}.`,
          `${formatBytes(candidate.reclaimableBytes)} is potentially reclaimable after keeping one copy.`,
          operation.rollbackHint ?? "Recycle Bin rollback metadata unavailable.",
        ],
        operation,
      };
      return [...current.filter((action) => action.id !== id), nextAction];
    });
  }

  function rememberRetainedDuplicatePath(groupId: number, files: NativeDuplicateFile[]) {
    if (files.length === 0) return;

    setRetainedDuplicatePaths((current) => {
      if (current[groupId] && files.some((file) => file.path === current[groupId])) {
        return current;
      }

      const stagedKeepPath = stagedActions
        .map((action) => action.operation)
        .find((operation) => operation?.kind === "recycleFiles" && operation.keepPath && files.some((file) => file.path === operation.keepPath))
        ?.keepPath;
      const fallbackKeepPath = suggestDuplicateKeepFile(files)?.file.path;
      const keepPath = stagedKeepPath ?? fallbackKeepPath;

      return keepPath ? { ...current, [groupId]: keepPath } : current;
    });
  }

  function duplicateFileStatus(file: PreviewableFile) {
    const candidate = scan.duplicateCandidates.find((item) => item.id === selectedDuplicateGroup);
    if (!candidate?.id) return { label: "Review", tone: "manual" as const };
    const groupId = candidate.id;

    const stagedOperation = stagedActions
      .map((action) => action.operation)
      .find((operation) => operation?.kind === "recycleFiles" && operation.keepPath === retainedDuplicatePaths[groupId]);

    if (stagedOperation?.keepPath === file.path) return { label: "Retained", tone: "safe" as const };
    if (stagedOperation?.removePaths.includes(file.path)) return { label: "Staged recycle", tone: "risky" as const };
    if (retainedDuplicatePaths[groupId] === file.path) return { label: "Retained", tone: "safe" as const };
    return { label: "Delete candidate", tone: "medium" as const };
  }

  async function commitStagedActions() {
    if (!nativeRuntime) {
      setRuntimeMessage("Recycle Bin commits are available in the desktop app");
      return;
    }
    if (!isWindowsRuntime) {
      setRuntimeMessage("Recycle Bin commits are currently available on Windows only");
      return;
    }

    const recycleActions = actionableStagedActions;
    const validationFailures = new Map<string, string[]>();
    const validActions: StagedAction[] = [];

    for (const action of recycleActions) {
      const expectedFiles = action.operation?.expectedFiles ?? [];
      if (expectedFiles.length === 0) {
        validationFailures.set(action.id, ["validation metadata is missing"]);
        continue;
      }

      let validation: Awaited<ReturnType<typeof validateNativeCleanupFiles>>;
      try {
        validation = await validateNativeCleanupFiles(expectedFiles);
      } catch (error) {
        setRuntimeMessage(error instanceof Error ? error.message : "Pre-commit validation failed");
        return;
      }
      if (validation.can_commit) {
        validActions.push(action);
      } else {
        validationFailures.set(action.id, validation.results
          .filter((result) => result.status !== "valid")
          .map((result) => `${result.path}: ${result.reason ?? "changed since scan"}`));
      }
    }

    if (validationFailures.size > 0) {
      setStagedActions((current) => current.map((action) => {
        const failures = validationFailures.get(action.id);
        if (!failures) return action;
        return {
          ...action,
          confidence: "Risky",
          reason: "This staged cleanup is stale and was blocked before commit.",
          suggestedAction: "Refresh or rescan this duplicate group before committing it.",
          evidence: [...action.evidence, ...failures.map((failure) => `Blocked: ${failure}`)],
        };
      }));
    }

    const paths = [...new Set(validActions.flatMap((action) => action.operation?.removePaths ?? []))];
    if (paths.length === 0) {
      if (validationFailures.size > 0) {
        setRuntimeMessage("Pre-commit validation blocked stale duplicate cleanup items");
        return;
      }
      setRuntimeMessage("No safe recycle actions are ready to commit");
      return;
    }

    const blockedNote = validationFailures.size > 0 ? ` ${formatCount(validationFailures.size)} stale staged item(s) will stay in the queue.` : "";
    const confirmed = window.confirm(`Move ${formatCount(paths.length)} duplicate files to the Recycle Bin? Kept copies stay in place.${blockedNote}`);
    if (!confirmed) return;

    setCommittingActions(true);
    try {
      const result = await recycleNativeFiles(paths);
      const committedIds = new Set(validActions.map((action) => action.id));
      setStagedActions((current) => current.filter((action) => !committedIds.has(action.id)));
      setDuplicateFiles([]);
      setSelectedDuplicateGroup(null);
      if (currentIndexPath) {
        try {
          const refresh = await refreshNativeIndexPaths(currentIndexPath, paths);
          const overview = await queryNativeIndex(currentIndexPath, 1000);
          setScan((current) => mergeNativeOverview(current, overview));
          setRuntimeMessage(`Moved ${formatCount(result.moved)} duplicate files to the Recycle Bin. Refreshed ${formatCount(refresh.deleted + refresh.refreshed)} changed index paths.`);
        } catch (error) {
          setRuntimeMessage(error instanceof Error
            ? error.message
            : `Moved ${formatCount(result.moved)} duplicate files. Rescan to refresh the index.`);
        }
      } else {
        setRuntimeMessage(`Moved ${formatCount(result.moved)} duplicate files to the Recycle Bin. Rescan the folder to refresh the index.`);
      }
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Failed to recycle duplicate files");
    } finally {
      setCommittingActions(false);
    }
  }

  function stageSuggestedMove(suggestion: MoveSuggestion) {
    setStagedActions((current) => {
      const id = `move-${suggestion.category}-${suggestion.destination}`;
      if (current.some((action) => action.id === id)) return current;
      return [
        ...current,
        {
          id,
          label: `Review ${categories[suggestion.category].label} move plan`,
          confidence: "Manual review",
          bytes: suggestion.bytes,
          reason: `${formatCount(suggestion.folderCount)} folders contain ${categories[suggestion.category].label.toLowerCase()}. Suggested destination: ${suggestion.destination}.`,
          suggestedAction: `Stage a move preview into ${suggestion.destination}; no files move until commit exists.`,
          evidence: [
            `${formatBytes(suggestion.bytes)} of ${categories[suggestion.category].label.toLowerCase()} are scattered across the scan.`,
            `${formatCount(suggestion.folderCount)} folders contain this media type; biggest source is ${suggestion.sourceFolders[0]?.path ?? "unknown"}.`,
            suggestion.yearBuckets.length > 0
              ? `File timestamps suggest year buckets: ${suggestion.yearBuckets.map((bucket) => `${bucket.year} (${formatCount(bucket.files)})`).join(", ")}.`
              : "Date-based grouping still needs richer metadata before it can be automated.",
          ],
        },
      ];
    });
  }

  function stageHeatmapAction(folder: FolderStats, action: HeatmapActionCell) {
    const id = `heatmap-${action.key}-${folder.path}`;
    setStagedActions((current) => {
      if (current.some((staged) => staged.id === id)) return current;
      return [
        ...current,
        {
          id,
          label: `Review ${action.label.toLowerCase()} in ${lastSegment(folder.path)}`,
          confidence: action.key === "duplicates" ? "Medium" : "Manual review",
          bytes: action.bytes,
          reason: `${formatBytes(action.bytes)} flagged under ${action.label.toLowerCase()} for this folder.`,
          suggestedAction: action.key === "duplicates"
            ? "Open duplicate candidates, choose retained copies, then stage exact groups individually."
            : `Review ${folder.path} before deciding whether to move, archive, or delete anything.`,
          evidence: [
            `${folder.path} contains ${formatCount(folder.files)} indexed files.`,
            `${action.label} is currently the strongest cleanup signal for this cell.`,
            "This queues review only; no file operation is executed.",
          ],
        },
      ];
    });
  }

  async function refreshSavedIndexes() {
    try {
      setSavedIndexes(await listNativeIndexes());
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Failed to list indexes");
    }
  }

  async function openSavedIndex(entry: NativeIndexEntry) {
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
    setActivePage("workspace");
  }

  async function rescanSavedIndex(entry: NativeIndexEntry) {
    if (!entry.root_path) return;
    const { jobId, indexPath } = await startNativeScan(entry.root_path);
    nativeJobRef.current = { jobId, indexPath };
    setCurrentIndexPath(null);
    setRuntimeMessage("Native rescan starting");
    setScan({
      ...initialScanState,
      status: "scanning",
      rootName: lastSegment(entry.root_path) || entry.root_path,
      startedAt: performance.now(),
      currentPath: entry.root_path,
    });
    setActivePage("workspace");
  }

  async function removeSavedIndex(entry: NativeIndexEntry) {
    await deleteNativeIndex(entry.index_path);
    if (currentIndexPath === entry.index_path) {
      clearScan();
    }
    await refreshSavedIndexes();
  }

  function toggleSelectedFolder(path: string) {
    setSelectedFolders((current) => {
      if (current.includes(path)) {
        return current.filter((entry) => entry !== path);
      }
      return [...current, path];
    });
  }
}

function mergeNativeOverview(scan: ScanState, overview: NativeIndexOverview): ScanState {
  const folderCategoryMap = new Map<string, ReturnType<typeof emptyFolderCategories>>();
  const folderPaths = overview.folders.map((folder) => folder.path);
  for (const media of overview.folder_media) {
    for (const folderPath of folderPaths) {
      if (folderPath === media.folder_path || isDescendantPath(media.folder_path, folderPath)) {
        const categories = folderCategoryMap.get(folderPath) ?? emptyFolderCategories();
        categories[categoryFromMediaKind(media.media_kind)] += media.total_bytes;
        folderCategoryMap.set(folderPath, categories);
      }
    }
  }

  const folders = overview.folders.map((folder) => ({
    path: folder.path,
    files: folder.total_files,
    bytes: folder.total_bytes,
    categories: folderCategoryMap.get(folder.path) ?? emptyFolderCategories(),
  }));
  const largestFiles = mergeNativeFiles([...(overview.files ?? []), ...(overview.timeline_files ?? [])]).map((file) => ({
    path: file.path,
    name: lastSegment(file.path),
    folder: file.path.includes("\\") ? file.path.slice(0, file.path.lastIndexOf("\\")) : file.path.slice(0, file.path.lastIndexOf("/")),
    extension: file.extension ?? "(none)",
    bytes: file.size,
    category: categoryFromMediaKind(file.media_kind),
    modified: file.modified_at ? file.modified_at * 1000 : 0,
  }));
  const extensions = overview.extensions.map((extension) => ({
    extension: extension.extension,
    files: extension.file_count,
    bytes: extension.total_bytes,
  }));
  const duplicateCandidates = overview.duplicate_groups.map((group) => ({
    id: group.id,
    size: group.size,
    files: group.file_count,
    folderCount: group.folder_count,
    folderPaths: group.folder_paths,
    dominantMediaKind: group.dominant_media_kind,
    reclaimableBytes: group.reclaimable_bytes,
    cleanupScore: group.cleanup_score,
    samples: [`confidence ${(group.confidence * 100).toFixed(0)}%`],
    confidence: "size-match" as const,
    confidenceScore: group.confidence,
  }));
  const duplicateOverlaps = overview.duplicate_overlaps.map((overlap) => ({
    folderA: overlap.folder_a,
    folderB: overlap.folder_b,
    sharedGroups: overlap.shared_groups,
    sharedFiles: overlap.shared_files,
    reclaimableBytes: overlap.reclaimable_bytes,
  }));
  const categoryTotals = emptyCategories();
  for (const media of overview.media) {
    const category = categoryFromMediaKind(media.media_kind);
    categoryTotals[category].files += media.file_count;
    categoryTotals[category].bytes += media.total_bytes;
  }

  return {
    ...scan,
    folders,
    largestFiles,
    extensions,
    duplicateCandidates,
    duplicateOverlaps,
    categories: categoryTotals,
  };
}

function mergeNativeFiles(files: NativeIndexOverview["files"]) {
  const byPath = new Map<string, NativeIndexOverview["files"][number]>();
  for (const file of files) {
    byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => b.size - a.size);
}

function categoryFromMediaKind(kind: string): CategoryKey {
  if (kind === "photo") return "photos";
  if (kind === "video") return "videos";
  if (kind === "music") return "music";
  if (kind === "archive") return "archives";
  if (kind === "document") return "documents";
  if (kind === "code") return "code";
  if (kind === "installer") return "installers";
  if (kind === "model") return "models";
  return "other";
}

function mediaKindLabel(kind?: string) {
  return categories[categoryFromMediaKind(kind ?? "other")].label;
}

function mediaKindFromCategory(category: CategoryKey) {
  if (category === "photos") return "photo";
  if (category === "videos") return "video";
  if (category === "archives") return "archive";
  if (category === "documents") return "document";
  if (category === "installers") return "installer";
  if (category === "models") return "model";
  return category === "other" ? "other" : category;
}

function confidenceClass(confidence: StagedAction["confidence"]) {
  if (confidence === "Safe") return "safe";
  if (confidence === "Medium") return "medium";
  if (confidence === "Risky") return "risky";
  return "manual";
}

type SunburstSlice = {
  path: string;
  bytes: number;
  files: number;
  depth: number;
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
  color: string;
};

type HeatmapActionCell = {
  key: string;
  label: string;
  bytes: number;
};

function buildSunburstSlices(folders: FolderStats[]): SunburstSlice[] {
  const visibleFolders = folders.filter((folder) => folder.bytes > 0);
  if (visibleFolders.length === 0) return [];

  const roots = visibleFolders.filter((folder) => !visibleFolders.some((candidate) => parentPath(folder.path) === candidate.path));
  const rootBytes = roots.reduce((sum, folder) => sum + folder.bytes, 0);
  if (rootBytes <= 0) return [];

  const maxDepth = Math.max(...visibleFolders.map((folder) => folder.path.split(/[\\/]/).filter(Boolean).length), 1);
  const ringWidth = 78 / Math.min(maxDepth, 5);
  const slices: SunburstSlice[] = [];

  let cursor = -90;
  for (const root of roots.sort((a, b) => b.bytes - a.bytes)) {
    const sweep = (root.bytes / rootBytes) * 360;
    appendSunburstBranch(root, visibleFolders, cursor, cursor + sweep, 0, ringWidth, slices);
    cursor += sweep;
  }

  return slices;
}

function appendSunburstBranch(
  folder: FolderStats,
  folders: FolderStats[],
  startAngle: number,
  endAngle: number,
  depth: number,
  ringWidth: number,
  slices: SunburstSlice[],
) {
  const boundedDepth = Math.min(depth, 4);
  const innerRadius = 28 + boundedDepth * ringWidth;
  const outerRadius = innerRadius + ringWidth - 2;
  slices.push({
    path: folder.path,
    bytes: folder.bytes,
    files: folder.files,
    depth,
    innerRadius,
    outerRadius,
    startAngle,
    endAngle,
    color: categories[getDominantFolderCategory(folder)].color,
  });

  if (depth >= 4) return;

  const children = folders.filter((candidate) => parentPath(candidate.path) === folder.path && candidate.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const childBytes = children.reduce((sum, child) => sum + child.bytes, 0);
  if (childBytes <= 0) return;

  let cursor = startAngle;
  for (const child of children) {
    const sweep = ((endAngle - startAngle) * child.bytes) / childBytes;
    appendSunburstBranch(child, folders, cursor, cursor + sweep, depth + 1, ringWidth, slices);
    cursor += sweep;
  }
}

function getDominantFolderCategory(folder: FolderStats): CategoryKey {
  return (Object.keys(folder.categories) as CategoryKey[]).reduce((best, key) => {
    return folder.categories[key] > folder.categories[best] ? key : best;
  }, "other");
}

function describeArc(cx: number, cy: number, innerRadius: number, outerRadius: number, startAngle: number, endAngle: number) {
  const startOuter = polarPoint(cx, cy, outerRadius, endAngle);
  const endOuter = polarPoint(cx, cy, outerRadius, startAngle);
  const startInner = polarPoint(cx, cy, innerRadius, startAngle);
  const endInner = polarPoint(cx, cy, innerRadius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;

  return [
    "M", startOuter.x, startOuter.y,
    "A", outerRadius, outerRadius, 0, largeArcFlag, 0, endOuter.x, endOuter.y,
    "L", startInner.x, startInner.y,
    "A", innerRadius, innerRadius, 0, largeArcFlag, 1, endInner.x, endInner.y,
    "Z",
  ].join(" ");
}

function polarPoint(cx: number, cy: number, radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(radians),
    y: cy + radius * Math.sin(radians),
  };
}

function DuplicateOverlapGraph({ overlaps, onSelectFolder }: { overlaps: DuplicateOverlap[]; onSelectFolder: (path: string) => void }) {
  const [weightMode, setWeightMode] = useState<"bytes" | "files">("bytes");
  const weight = (overlap: DuplicateOverlap) => weightMode === "bytes" ? overlap.reclaimableBytes : overlap.sharedFiles;
  const formatWeight = (value: number) => weightMode === "bytes" ? formatBytes(value) : formatCount(value);
  const topOverlaps = [...overlaps]
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, 8);
  if (topOverlaps.length === 0) {
    return null;
  }

  const folderStats = new Map<string, { weight: number; overlaps: number }>();
  for (const overlap of overlaps) {
    const value = weight(overlap);
    for (const path of [overlap.folderA, overlap.folderB]) {
      const entry = folderStats.get(path) ?? { weight: 0, overlaps: 0 };
      entry.weight += value;
      entry.overlaps += 1;
      folderStats.set(path, entry);
    }
  }
  const topFolders = [...folderStats.entries()]
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, 5)
    .map(([path, stats]) => ({ path, ...stats }));

  const folderWeights = new Map<string, number>();
  for (const overlap of topOverlaps) {
    const value = weight(overlap);
    folderWeights.set(overlap.folderA, (folderWeights.get(overlap.folderA) ?? 0) + value);
    folderWeights.set(overlap.folderB, (folderWeights.get(overlap.folderB) ?? 0) + value);
  }

  const folders = [...folderWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([path, weightValue], index, list) => {
      const angle = list.length === 1 ? 0 : (Math.PI * 2 * index) / list.length - Math.PI / 2;
      return {
        path,
        weight: weightValue,
        x: 50 + Math.cos(angle) * 27,
        y: 50 + Math.sin(angle) * 27,
      };
    });
  const folderByPath = new Map(folders.map((folder) => [folder.path, folder]));
  const maxWeight = Math.max(...topOverlaps.map((overlap) => weight(overlap)), 1);

  return (
    <div className="overlap-graph" aria-label="Duplicate overlap graph">
      <div className="overlap-canvas">
        <svg viewBox="0 0 100 100" role="img" aria-label="Folders connected by shared duplicate files">
          {topOverlaps.map((overlap) => {
            const source = folderByPath.get(overlap.folderA);
            const target = folderByPath.get(overlap.folderB);
            if (!source || !target) return null;
            const width = 1.5 + (weight(overlap) / maxWeight) * 7;
            return (
              <line
                key={`${overlap.folderA}-${overlap.folderB}`}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                strokeWidth={width}
              />
            );
          })}
          {folders.map((folder) => {
            const radius = 7 + Math.min(9, Math.sqrt(folder.weight / Math.max(maxWeight, 1)) * 7);
            return (
              <g
                className="overlap-node"
                key={folder.path}
                onClick={() => onSelectFolder(folder.path)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectFolder(folder.path);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <circle cx={folder.x} cy={folder.y} r={radius} />
                <text x={folder.x} y={folder.y + 1.5}>{lastSegment(folder.path)}</text>
                <title>{folder.path}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="overlap-list">
        <div className="overlap-toggle" role="group" aria-label="Overlap weighting">
          <span>Weight</span>
          <button type="button" className={weightMode === "bytes" ? "active" : ""} onClick={() => setWeightMode("bytes")}>
            Reclaim
          </button>
          <button type="button" className={weightMode === "files" ? "active" : ""} onClick={() => setWeightMode("files")}>
            Files
          </button>
        </div>
        <div className="overlap-section">
          <h4>Top overlap pairs</h4>
          {topOverlaps.slice(0, 4).map((overlap) => (
            <div className="overlap-pair" key={`${overlap.folderA}-${overlap.folderB}`}>
              <strong>{formatWeight(weight(overlap))}</strong>
              <span className="overlap-pair-label">
                <button
                  className="overlap-target"
                  type="button"
                  title={overlap.folderA}
                  onClick={() => onSelectFolder(overlap.folderA)}
                >
                  {lastSegment(overlap.folderA)}
                </button>
                <span aria-hidden="true">/</span>
                <button
                  className="overlap-target"
                  type="button"
                  title={overlap.folderB}
                  onClick={() => onSelectFolder(overlap.folderB)}
                >
                  {lastSegment(overlap.folderB)}
                </button>
              </span>
              <small>{formatCount(overlap.sharedGroups)} groups, {formatCount(overlap.sharedFiles)} files</small>
            </div>
          ))}
        </div>
        <div className="overlap-section">
          <h4>Most affected folders ({weightMode === "bytes" ? "reclaim" : "files"})</h4>
          {topFolders.map((folder) => (
            <button
              className="overlap-pair overlap-folder"
              key={folder.path}
              type="button"
              title={folder.path}
              onClick={() => onSelectFolder(folder.path)}
            >
              <strong>{formatWeight(folder.weight)}</strong>
              <span>{lastSegment(folder.path)}</span>
              <small>{formatCount(folder.overlaps)} overlaps</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DuplicateSummary({
  candidates,
  overlaps,
}: {
  candidates: ScanState["duplicateCandidates"];
  overlaps: DuplicateOverlap[];
}) {
  const reclaimable = candidates.reduce((sum, candidate) => sum + candidate.reclaimableBytes, 0);
  const exactGroups = candidates.filter((candidate) => candidate.confidenceScore === 1).length;
  const copies = candidates.reduce((sum, candidate) => sum + candidate.files, 0);

  return (
    <div className="duplicate-summary">
      <div>
        <span>Potential reclaim</span>
        <strong>{formatBytes(reclaimable)}</strong>
      </div>
      <div>
        <span>Exact groups</span>
        <strong>{formatCount(exactGroups)}</strong>
      </div>
      <div>
        <span>Duplicate copies</span>
        <strong>{formatCount(copies)}</strong>
      </div>
      <p>
        Start with groups marked Safe. Each row is one duplicate set: keep one copy, review the listed files, then stage the group into the Review Queue.
        {overlaps.length > 0 ? " The folder overlap map is available for spotting folders that share many duplicate files." : ""}
      </p>
    </div>
  );
}

function DuplicateReviewControls({
  filters,
  resultCount,
  sort,
  onFiltersChange,
  onSortChange,
}: {
  filters: DuplicateReviewFilters;
  resultCount: number;
  sort: DuplicateSortKey;
  onFiltersChange: React.Dispatch<React.SetStateAction<DuplicateReviewFilters>>;
  onSortChange: React.Dispatch<React.SetStateAction<DuplicateSortKey>>;
}) {
  return (
    <div className="duplicate-review-controls">
      <label>
        <span>Sort</span>
        <select value={sort} onChange={(event) => onSortChange(event.currentTarget.value as DuplicateSortKey)}>
          <option value="cleanup">Cleanup score</option>
          <option value="reclaimable">Reclaimable bytes</option>
          <option value="files">File count</option>
          <option value="folders">Folder count</option>
          <option value="confidence">Confidence</option>
        </select>
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={filters.exactOnly}
          onChange={(event) => onFiltersChange((current) => ({ ...current, exactOnly: event.currentTarget.checked }))}
        />
        <span>Exact only</span>
      </label>
      <label>
        <span>Media</span>
        <select value={filters.mediaKind} onChange={(event) => onFiltersChange((current) => ({ ...current, mediaKind: event.currentTarget.value as DuplicateReviewFilters["mediaKind"] }))}>
          <option value="all">All</option>
          <option value="photos">Images</option>
          <option value="videos">Videos</option>
          <option value="documents">Documents</option>
          <option value="music">Audio</option>
          <option value="archives">Archives</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label>
        <span>Confidence</span>
        <select value={filters.confidence} onChange={(event) => onFiltersChange((current) => ({ ...current, confidence: event.currentTarget.value as DuplicateReviewFilters["confidence"] }))}>
          <option value="all">All</option>
          <option value="safe">Safe</option>
          <option value="medium">Medium</option>
          <option value="review">Review</option>
        </select>
      </label>
      <label>
        <span>Min MB</span>
        <input value={filters.minReclaimMb} inputMode="numeric" onChange={(event) => onFiltersChange((current) => ({ ...current, minReclaimMb: event.currentTarget.value.replace(/[^0-9.]/g, "") }))} />
      </label>
      <label>
        <span>Folder contains</span>
        <input value={filters.folderContains} onChange={(event) => onFiltersChange((current) => ({ ...current, folderContains: event.currentTarget.value }))} />
      </label>
      <label>
        <span>Path contains</span>
        <input value={filters.pathContains} onChange={(event) => onFiltersChange((current) => ({ ...current, pathContains: event.currentTarget.value }))} />
      </label>
      {filters.folderPair && (
        <button type="button" onClick={() => onFiltersChange((current) => ({ ...current, folderPair: null }))}>
          Clear pair
        </button>
      )}
      <button type="button" onClick={() => onFiltersChange(initialDuplicateFilters)}>
        Reset
      </button>
      <strong>{formatCount(resultCount)} shown</strong>
    </div>
  );
}

function DuplicateCleanupEdgeStates({
  duplicateCount,
  nativeRuntime,
  isWindowsRuntime,
  staleStagedCount,
  runtimeMessage,
}: {
  duplicateCount: number;
  nativeRuntime: boolean;
  isWindowsRuntime: boolean;
  staleStagedCount: number;
  runtimeMessage: string;
}) {
  const states = [
    duplicateCount === 0 ? "No duplicate groups are currently available in this index." : "",
    !nativeRuntime ? "Desktop-only cleanup actions are disabled in browser preview mode." : "",
    nativeRuntime && !isWindowsRuntime ? "Recycle Bin commits are currently implemented for Windows only." : "",
    staleStagedCount > 0 ? `${formatCount(staleStagedCount)} staged duplicate cleanup ${staleStagedCount === 1 ? "item is" : "items are"} stale and blocked until refresh.` : "",
    /permission|denied|locked|in use/i.test(runtimeMessage) ? runtimeMessage : "",
  ].filter(Boolean);

  if (states.length === 0) return null;

  return (
    <div className="duplicate-edge-states">
      {states.map((state) => (
        <span key={state}>{state}</span>
      ))}
    </div>
  );
}

function FolderPairDuplicateSummary({
  overlaps,
  activePair,
  onReviewPair,
}: {
  overlaps: DuplicateOverlap[];
  activePair: DuplicateReviewFilters["folderPair"];
  onReviewPair: (pair: { folderA: string; folderB: string }) => void;
}) {
  return (
    <div className="folder-pair-summary">
      {overlaps.slice(0, 5).map((overlap) => {
        const active = activePair?.folderA === overlap.folderA && activePair.folderB === overlap.folderB;
        return (
          <div className={active ? "active" : ""} key={`${overlap.folderA}-${overlap.folderB}`}>
            <span title={overlap.folderA}>{overlap.folderA}</span>
            <MoveRight size={15} />
            <span title={overlap.folderB}>{overlap.folderB}</span>
            <strong>{formatBytes(overlap.reclaimableBytes)}</strong>
            <small>{formatCount(overlap.sharedGroups)} groups</small>
            <button type="button" onClick={() => onReviewPair({ folderA: overlap.folderA, folderB: overlap.folderB })}>
              Review pair
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ExactDuplicateBatchReview({
  candidates,
  selectedIds,
  onSelectedIdsChange,
  onStageSelected,
}: {
  candidates: ScanState["duplicateCandidates"];
  selectedIds: number[];
  onSelectedIdsChange: React.Dispatch<React.SetStateAction<number[]>>;
  onStageSelected: () => void;
}) {
  const visibleIds = candidates.flatMap((candidate) => candidate.id ? [candidate.id] : []);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  return (
    <div className="exact-batch-review">
      <div className="exact-batch-header">
        <div>
          <strong>Batch review for exact duplicates</strong>
          <span>{formatCount(candidates.length)} full-hash groups are eligible. Risky groups are excluded.</span>
        </div>
        <button type="button" onClick={() => onSelectedIdsChange(allVisibleSelected ? [] : visibleIds)}>
          {allVisibleSelected ? "Deselect all" : "Select all"}
        </button>
        <button type="button" disabled={selectedIds.length === 0} onClick={onStageSelected}>
          Stage selected
        </button>
      </div>
      <div className="exact-batch-table">
        {candidates.slice(0, 12).map((candidate) => {
          const id = candidate.id;
          if (!id) return null;
          return (
            <label key={id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(id)}
                onChange={(event) => onSelectedIdsChange((current) => event.currentTarget.checked
                  ? [...new Set([...current, id])]
                  : current.filter((selectedId) => selectedId !== id))}
              />
              <span>{formatCount(candidate.files)} copies</span>
              <strong>{formatBytes(candidate.reclaimableBytes)}</strong>
              <small>{formatCount(candidate.folderCount ?? 1)} folders</small>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function DuplicateComparisonPanel({
  files,
  exact,
  nativeRuntime,
}: {
  files: PreviewableFile[];
  exact: boolean;
  nativeRuntime: boolean;
}) {
  if (files.length < 2) {
    return (
      <div className="duplicate-comparison-panel empty">
        <strong>Select two copies to compare</strong>
        <span>Use the compare action on duplicate rows before choosing which copy to keep.</span>
      </div>
    );
  }

  const [left, right] = files;
  const sameSize = left.size === right.size;
  const sameModified = left.modifiedAt === right.modifiedAt;
  const sameExtension = left.extension === right.extension;
  const sameMediaKind = left.mediaKind === right.mediaKind;
  const sameHashStatus = left.hashMatchType === right.hashMatchType && left.confidence === right.confidence;

  return (
    <div className={`duplicate-comparison-panel ${exact ? "exact" : "review"}`}>
      <div className="duplicate-comparison-header">
        <div>
          <strong>{exact ? "Content is identical" : "Review required"}</strong>
          <span>{exact ? "Keeping either copy preserves the file data." : "These candidates are not full-hash confirmed; inspect before staging cleanup."}</span>
        </div>
        <small className={`confidence-pill ${exact ? "safe" : "medium"}`}>{exact ? "Safe" : "Review"}</small>
      </div>
      <div className="duplicate-comparison-files">
        {[left, right].map((file) => (
          <div key={file.path} className="duplicate-comparison-card">
            <ComparisonPreview file={file} nativeRuntime={nativeRuntime} />
            <strong title={file.name}>{file.name}</strong>
            <span title={file.path}>{file.path}</span>
            <small title={file.folderPath}>{file.folderPath}</small>
          </div>
        ))}
      </div>
      <div className="duplicate-comparison-grid">
        <ComparisonRow label="Path" left={left.path} right={right.path} same={left.path === right.path} />
        <ComparisonRow label="Modified" left={left.modifiedAt ? formatDate(left.modifiedAt) : "No date"} right={right.modifiedAt ? formatDate(right.modifiedAt) : "No date"} same={sameModified} />
        <ComparisonRow label="Size" left={formatBytes(left.size)} right={formatBytes(right.size)} same={sameSize} />
        <ComparisonRow label="Hash status" left={`${left.hashMatchType ?? "size"} - ${Math.round((left.confidence ?? 0) * 100)}%`} right={`${right.hashMatchType ?? "size"} - ${Math.round((right.confidence ?? 0) * 100)}%`} same={sameHashStatus} />
        <ComparisonRow label="Metadata" left={`${left.mediaKind}, ${left.extension}`} right={`${right.mediaKind}, ${right.extension}`} same={sameExtension && sameMediaKind} />
      </div>
    </div>
  );
}

function ComparisonPreview({ file, nativeRuntime }: { file: PreviewableFile; nativeRuntime: boolean }) {
  const canRenderPhoto = nativeRuntime && file.category === "photos";
  const canRenderVideo = nativeRuntime && file.category === "videos";
  const canRenderAudio = nativeRuntime && file.category === "music";

  return (
    <div className="comparison-preview">
      {canRenderPhoto && <img src={convertFileSrc(file.path)} alt="" loading="lazy" />}
      {canRenderVideo && <video src={convertFileSrc(file.path)} preload="metadata" muted />}
      {canRenderAudio && <audio src={convertFileSrc(file.path)} controls preload="metadata" />}
      {!canRenderPhoto && !canRenderVideo && !canRenderAudio && fileTypeIcon(file, 26)}
    </div>
  );
}

function ComparisonRow({ label, left, right, same }: { label: string; left: string; right: string; same: boolean }) {
  return (
    <div className={`comparison-row ${same ? "same" : "different"}`}>
      <span>{label}</span>
      <strong title={left}>{left}</strong>
      <strong title={right}>{right}</strong>
      <small>{same ? "Same" : "Different"}</small>
    </div>
  );
}

function StagedDuplicateAudit({ action }: { action: StagedAction }) {
  if (action.operation?.kind !== "recycleFiles") return null;

  const operation = action.operation;
  const recyclePreview = operation.recycleFiles?.slice(0, 4) ?? operation.removePaths.slice(0, 4).map((path, index) => ({
    id: operation.removeFileIds?.[index] ?? index,
    path,
    name: lastSegment(path),
    size: 0,
  }));
  const remainingRecycleFiles = Math.max(0, operation.removePaths.length - recyclePreview.length);
  const staleWarnings = action.evidence.filter((item) => item.startsWith("Blocked:"));

  return (
    <div className="staged-duplicate-audit">
      <div className="staged-operation-meta">
        <span>Group {operation.duplicateGroupId ?? "n/a"}</span>
        <span>Keep file {operation.keepFileId ?? "n/a"}</span>
        <span>Recycle {formatCount(operation.removeFileIds?.length ?? operation.removePaths.length)} files</span>
      </div>
      <div className="staged-audit-grid">
        <div>
          <span>Retained copy</span>
          <strong title={operation.keepPath}>{operation.keepName ?? lastSegment(operation.keepPath)}</strong>
          <small title={operation.keepPath}>{operation.keepPath}</small>
        </div>
        <div>
          <span>Reclaimable space</span>
          <strong>{formatBytes(action.bytes)}</strong>
          <small>{action.confidence} confidence</small>
        </div>
      </div>
      <div className="staged-recycle-list">
        <span>Copies to recycle</span>
        {recyclePreview.map((file) => (
          <div key={`${file.id}-${file.path}`}>
            <strong title={file.path}>{file.name}</strong>
            <small>{file.size > 0 ? formatBytes(file.size) : "Indexed duplicate"}</small>
          </div>
        ))}
        {remainingRecycleFiles > 0 && <small>{formatCount(remainingRecycleFiles)} more copies queued</small>}
      </div>
      {(operation.affectedFolders?.length ?? 0) > 0 && (
        <div className="staged-folder-list">
          <span>Affected folders</span>
          {operation.affectedFolders?.map((folder) => (
            <div key={folder.path}>
              <strong title={folder.path}>{folder.path}</strong>
              <small>{formatCount(folder.files)} copies - {formatBytes(folder.bytes)}</small>
            </div>
          ))}
        </div>
      )}
      {staleWarnings.length > 0 && (
        <div className="staged-warning">
          <strong>Commit blocked</strong>
          {staleWarnings.map((warning) => (
            <span key={warning}>{warning.replace("Blocked: ", "")}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionHeatmap({ scan, onStageAction }: { scan: ScanState; onStageAction: (folder: FolderStats, action: HeatmapActionCell) => void }) {
  const duplicateBytesByFolder = new Map<string, number>();
  for (const overlap of scan.duplicateOverlaps) {
    const half = overlap.reclaimableBytes / 2;
    duplicateBytesByFolder.set(overlap.folderA, (duplicateBytesByFolder.get(overlap.folderA) ?? 0) + half);
    duplicateBytesByFolder.set(overlap.folderB, (duplicateBytesByFolder.get(overlap.folderB) ?? 0) + half);
  }

  const rows = scan.folders
    .map((folder) => {
      const cells = [
        { key: "duplicates", label: "Duplicates", bytes: duplicateBytesByFolder.get(folder.path) ?? 0 },
        { key: "installers", label: "Installers", bytes: folder.categories.installers },
        { key: "archives", label: "Archives", bytes: folder.categories.archives },
        { key: "misc", label: "Misc", bytes: folder.categories.other },
      ];
      return {
        folder,
        cells,
        score: Math.max(...cells.map((cell) => cell.bytes)),
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const maxBytes = Math.max(...rows.flatMap((row) => row.cells.map((cell) => cell.bytes)), 1);

  if (rows.length === 0) {
    return <div className="empty-state compact">Scan results will turn into cleanup priorities here.</div>;
  }

  return (
    <div className="action-heatmap" aria-label="Cleanup action heatmap">
      <div className="heatmap-header">
        <span>Folder</span>
        <span>Duplicates</span>
        <span>Installers</span>
        <span>Archives</span>
        <span>Misc</span>
      </div>
      {rows.map((row) => (
        <div className="heatmap-row" key={row.folder.path}>
          <strong title={row.folder.path}>{lastSegment(row.folder.path)}</strong>
          {row.cells.map((cell) => {
            const intensity = cell.bytes / maxBytes;
            return (
              <button
                className="heatmap-cell"
                disabled={cell.bytes <= 0}
                key={cell.key}
                onClick={() => onStageAction(row.folder, cell)}
                style={{ "--heat": intensity.toFixed(3) } as React.CSSProperties}
                title={`${cell.label}: ${formatBytes(cell.bytes)} in ${row.folder.path}`}
                type="button"
              >
                {cell.bytes > 0 ? formatBytes(cell.bytes) : "-"}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function FocusedFolderSummary({ folder, onReveal }: { folder: FolderStats | null; onReveal: (path: string) => void }) {
  if (!folder) {
    return null;
  }

  const topCategories = (Object.keys(folder.categories) as CategoryKey[])
    .map((key) => ({ key, bytes: folder.categories[key] }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);

  return (
    <div className="focused-folder-summary">
      <div>
        <strong>{folder.path}</strong>
        <span>{formatBytes(folder.bytes)} across {formatCount(folder.files)} files</span>
      </div>
      <div className="focused-category-chips">
        {topCategories.map((entry) => (
          <span key={entry.key}>
            <i style={{ background: categories[entry.key].color }} />
            {categories[entry.key].label}: {formatBytes(entry.bytes)}
          </span>
        ))}
      </div>
      <IconButton title="Open selected folder in Explorer" onClick={() => onReveal(folder.path)}>
        <ExternalLink size={16} />
      </IconButton>
    </div>
  );
}

function SunburstHierarchy({ folders, onSelectFolder }: { folders: FolderStats[]; onSelectFolder: (path: string) => void }) {
  const slices = useMemo(() => buildSunburstSlices(folders), [folders]);
  const [activeSlice, setActiveSlice] = useState<SunburstSlice | null>(null);
  if (slices.length === 0) {
    return null;
  }

  return (
    <div className="sunburst-panel" aria-label="Depth-based folder hierarchy">
      <div className="panel-header compact">
        <h2>Hierarchy Rings</h2>
        <span>Depth by folder size</span>
      </div>
      <div className="sunburst-detail" aria-live="polite">
        {activeSlice ? (
          <>
            <strong>{lastSegment(activeSlice.path)}</strong>
            <span className="sunburst-path">{activeSlice.path}</span>
            <div className="sunburst-metrics">
              <small>{formatBytes(activeSlice.bytes)}</small>
              <small>{formatCount(activeSlice.files)} files</small>
              <small>Depth {formatCount(activeSlice.depth + 1)}</small>
            </div>
          </>
        ) : (
          <>
            <strong>Hover a ring</strong>
            <span className="sunburst-path">Click a segment to focus the folder in the treemap.</span>
          </>
        )}
      </div>
      <svg viewBox="0 0 220 220" role="img" aria-label="Folder hierarchy sunburst chart" onMouseLeave={() => setActiveSlice(null)}>
        {slices.map((slice) => (
          <path
            d={describeArc(110, 110, slice.innerRadius, slice.outerRadius, slice.startAngle, slice.endAngle)}
            fill={slice.color}
            key={`${slice.path}-${slice.depth}-${slice.startAngle}`}
            onClick={() => onSelectFolder(slice.path)}
            onMouseEnter={() => setActiveSlice(slice)}
            onFocus={() => setActiveSlice(slice)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectFolder(slice.path);
              }
            }}
            role="button"
            tabIndex={0}
          >
            <title>{slice.path}: {formatBytes(slice.bytes)}</title>
          </path>
        ))}
        <circle cx="110" cy="110" r="25" />
        <text x="110" y="107">Root</text>
        <text x="110" y="122">{formatCount(folders.length)}</text>
      </svg>
    </div>
  );
}

function TimelineScatter({
  files,
  nativeRuntime,
  onSelectFile,
}: {
  files: ScanState["largestFiles"];
  nativeRuntime: boolean;
  onSelectFile: (file: ScanState["largestFiles"][number]) => void;
}) {
  const [mediaFilter, setMediaFilter] = useState<CategoryKey | "all">("all");
  const timelineDragRef = useRef<{ x: number; start: number; end: number } | null>(null);
  const timelineDidPanRef = useRef(false);
  const timelineFiles = useMemo(() => {
    const timelineCategories: CategoryKey[] = ["photos", "videos", "music", "documents"];
    return files
      .filter((file) => timelineCategories.includes(file.category) && file.modified > 0)
      .sort((a, b) => a.modified - b.modified)
      .slice(0, 600);
  }, [files]);
  const timelineCounts = useMemo(() => {
    const counts = new Map<CategoryKey | "all", number>([
      ["all", timelineFiles.length],
      ["photos", 0],
      ["videos", 0],
      ["music", 0],
      ["documents", 0],
    ]);
    for (const file of timelineFiles) {
      counts.set(file.category, (counts.get(file.category) ?? 0) + 1);
    }
    return counts;
  }, [timelineFiles]);
  const points = useMemo(() => {
    return timelineFiles.filter((file) => mediaFilter === "all" || file.category === mediaFilter);
  }, [mediaFilter, timelineFiles]);
  const [zoomRange, setZoomRange] = useState<{ start: number; end: number } | null>(null);
  const [selectedFile, setSelectedFile] = useState<ScanState["largestFiles"][number] | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  useEffect(() => {
    setZoomRange(null);
    setSelectedFile(null);
  }, [points]);

  const hasEnoughPoints = points.length >= 2;
  const fallbackStart = timelineFiles[0]?.modified ?? Date.now();
  const fallbackEnd = timelineFiles[timelineFiles.length - 1]?.modified ?? fallbackStart;
  const rawMinTime = hasEnoughPoints ? points[0].modified : fallbackStart;
  const rawMaxTime = hasEnoughPoints ? points[points.length - 1].modified : fallbackEnd;
  const timelineEdgeBuffer = Math.max((rawMaxTime - rawMinTime) * 0.04, 1000 * 60 * 60 * 24 * 7);
  const minTime = rawMinTime - timelineEdgeBuffer;
  const maxTime = rawMaxTime + timelineEdgeBuffer;
  const visibleStart = zoomRange?.start ?? minTime;
  const visibleEnd = zoomRange?.end ?? maxTime;
  const visiblePoints = hasEnoughPoints ? points.filter((file) => file.modified >= visibleStart && file.modified <= visibleEnd) : [];
  const maxBytes = Math.max(...points.map((file) => file.bytes), 1);
  const span = Math.max(visibleEnd - visibleStart, 1);
  const clusters = hasEnoughPoints ? buildTimelineClusters(visiblePoints, visibleStart, visibleEnd) : [];
  const shouldSplitClusters = span < 1000 * 60 * 60 * 24 * 45;
  const filterLabel = mediaFilter === "all" ? "media files" : categories[mediaFilter].label.toLowerCase();
  const canPan = hasEnoughPoints && span < Math.max(maxTime - minTime, 1);

  function panTimeline(fraction: number) {
    if (!canPan) return;
    setZoomRange((current) => {
      const range = current ?? { start: visibleStart, end: visibleEnd };
      return panTimelineRange(range.start, range.end, fraction, minTime, maxTime);
    });
  }

  return (
    <section className="folder-table timeline-panel">
      <div className="panel-header">
        <h2>Media Timeline</h2>
        <span>{formatCount(visiblePoints.length)} visible / {formatCount(timelineFiles.length)} timestamped</span>
      </div>
      <div className="timeline-toolbar">
        <div className="timeline-filters" aria-label="Timeline media filters">
          {(["all", "photos", "videos", "music", "documents"] as Array<CategoryKey | "all">).map((key) => (
            <button
              className={mediaFilter === key ? "active" : ""}
              disabled={(timelineCounts.get(key) ?? 0) === 0}
              key={key}
              type="button"
              onClick={() => {
                setMediaFilter(key);
                setZoomRange(null);
              }}
            >
              {key === "all" ? "All" : categories[key].label}
              <small>{formatCount(timelineCounts.get(key) ?? 0)}</small>
            </button>
          ))}
        </div>
        <div className="timeline-pan-controls" aria-label="Timeline pan controls">
          <button type="button" onClick={() => panTimeline(-0.65)} disabled={!canPan}>Earlier</button>
          <button type="button" onClick={() => panTimeline(0.65)} disabled={!canPan}>Later</button>
        </div>
        <button type="button" onClick={() => setZoomRange(null)} disabled={!zoomRange}>Reset zoom</button>
        <span>{hasEnoughPoints ? `${formatDate(Math.floor(visibleStart / 1000))} to ${formatDate(Math.floor(visibleEnd / 1000))}` : `No timeline points for ${filterLabel}`}</span>
      </div>
      <div className="timeline-workbench">
        <div
          className={`timeline-scatter ${canPan ? "can-pan" : ""} ${isPanning ? "panning" : ""}`}
          aria-label="Media timeline scatter"
          onPointerDown={(event) => {
            if (!canPan) return;
            timelineDragRef.current = { x: event.clientX, start: visibleStart, end: visibleEnd };
            timelineDidPanRef.current = false;
            setIsPanning(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = timelineDragRef.current;
            if (!drag) return;
            const width = Math.max(event.currentTarget.getBoundingClientRect().width, 1);
            const delta = ((event.clientX - drag.x) / width) * (drag.end - drag.start);
            if (Math.abs(event.clientX - drag.x) > 4) {
              timelineDidPanRef.current = true;
            }
            setZoomRange(clampTimelineRange(drag.start - delta, drag.end - delta, minTime, maxTime));
          }}
          onWheel={(event) => {
            if (!canPan) return;
            event.preventDefault();
            const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            panTimeline(delta > 0 ? 0.18 : -0.18);
          }}
          onPointerUp={(event) => {
            if (!timelineDragRef.current) return;
            const didPan = timelineDidPanRef.current;
            timelineDragRef.current = null;
            setIsPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            if (!didPan) {
              timelineDidPanRef.current = false;
            }
          }}
          onPointerCancel={(event) => {
            if (!timelineDragRef.current) return;
            timelineDragRef.current = null;
            setIsPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            timelineDidPanRef.current = false;
          }}
        >
          {!hasEnoughPoints && (
            <div className="timeline-empty">
              <strong>{timelineFiles.length === 0 ? "No timestamped media yet" : `Not enough ${filterLabel}`}</strong>
              <span>{timelineFiles.length === 0 ? "Run or open an index with media files that have modified dates." : "Choose All or another media type to continue exploring."}</span>
              {mediaFilter !== "all" && <button type="button" onClick={() => setMediaFilter("all")}>Show all media</button>}
            </div>
          )}
          {clusters.map((cluster) => {
            if (cluster.files.length > 3 && !shouldSplitClusters) {
              const left = ((cluster.center - visibleStart) / span) * 100;
              const size = 30 + Math.min(34, Math.sqrt(cluster.files.length) * 8);
              return (
                <button
                  className="timeline-cluster"
                  key={`${cluster.start}-${cluster.end}-${cluster.files.length}`}
                  onClick={(event) => {
                    if (timelineDidPanRef.current) {
                      event.preventDefault();
                      timelineDidPanRef.current = false;
                      return;
                    }
                    setZoomRange(expandTimelineRange(cluster.start, cluster.end, minTime, maxTime));
                  }}
                  style={{ left: `${left}%`, top: "50%", width: size, height: size }}
                  title={`${formatCount(cluster.files.length)} files from ${formatDate(Math.floor(cluster.start / 1000))} to ${formatDate(Math.floor(cluster.end / 1000))}`}
                  type="button"
                >
                  {formatCount(cluster.files.length)}
                </button>
              );
            }

            return cluster.files.map((file, index) => {
              const left = ((file.modified - visibleStart) / span) * 100;
              const size = 7 + Math.min(13, Math.sqrt(file.bytes / maxBytes) * 13);
              const baseLane = timelineLane(file.category);
              const lane = baseLane + ((index % 5) - 2) * 3;
              return (
                <button
                  className={`timeline-dot ${file.category} ${selectedFile?.path === file.path ? "active" : ""}`}
                  key={file.path}
                  onClick={(event) => {
                    if (timelineDidPanRef.current) {
                      event.preventDefault();
                      timelineDidPanRef.current = false;
                      return;
                    }
                    setSelectedFile(file);
                    onSelectFile(file);
                  }}
                  style={{ left: `${left}%`, top: `${lane}%`, width: size, height: size }}
                  title={`${lastSegment(file.path)} - ${formatDate(Math.floor(file.modified / 1000))} - ${formatBytes(file.bytes)}`}
                  type="button"
                />
              );
            });
          })}
          <div className="timeline-axis">
            <span>{formatDate(Math.floor(visibleStart / 1000))}</span>
            <span>{formatDate(Math.floor(visibleEnd / 1000))}</span>
          </div>
        </div>
        <MediaPreviewPanel file={selectedFile} nativeRuntime={nativeRuntime} />
      </div>
    </section>
  );
}

function BeforeAfterSimulation({
  candidates,
  files,
  folders,
  nativeRuntime,
  overlaps,
}: {
  candidates: ScanState["duplicateCandidates"];
  files: ScanState["largestFiles"];
  folders: FolderStats[];
  nativeRuntime: boolean;
  overlaps: DuplicateOverlap[];
}) {
  const [simulationPercent, setSimulationPercent] = useState(100);
  const overlapBytesByFolder = useMemo(() => {
    const map = new Map<string, number>();
    for (const overlap of overlaps) {
      const half = overlap.reclaimableBytes / 2;
      map.set(overlap.folderA, (map.get(overlap.folderA) ?? 0) + half);
      map.set(overlap.folderB, (map.get(overlap.folderB) ?? 0) + half);
    }
    return map;
  }, [overlaps]);
  const candidateReclaimableBytes = candidates.reduce((sum, candidate) => sum + candidate.reclaimableBytes, 0);
  const overlapReclaimableBytes = [...overlapBytesByFolder.values()].reduce((sum, bytes) => sum + bytes, 0);
  const reclaimableBytes = Math.max(candidateReclaimableBytes, overlapReclaimableBytes);
  if (reclaimableBytes <= 0) {
    return null;
  }

  const currentFolders = folders
    .filter((folder) => folder.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 24)
    .map((folder) => ({ ...folder, displayBytes: folder.bytes }));
  const currentTotalBytes = currentFolders.reduce((sum, folder) => sum + folder.bytes, 0);
  const simulatedFolders = currentFolders.map((folder) => {
    const overlapReduction = overlapBytesByFolder.get(folder.path) ?? 0;
    const proportionalReduction = currentTotalBytes > 0 ? reclaimableBytes * (folder.bytes / currentTotalBytes) : 0;
    const rawReduction = overlapReduction > 0 ? overlapReduction : proportionalReduction;
    const reduction = rawReduction * (simulationPercent / 100);
    return {
      ...folder,
      displayBytes: Math.max(1, folder.bytes - reduction),
    };
  });
  const simulatedReclaimed = reclaimableBytes * (simulationPercent / 100);
  const simulationChanges = currentFolders
    .map((folder, index) => ({
      bytes: Math.max(0, folder.displayBytes - (simulatedFolders[index]?.displayBytes ?? folder.displayBytes)),
      label: lastSegment(folder.path),
      path: folder.path,
    }))
    .filter((change) => change.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);

  return (
    <section className="folder-table simulation-panel">
      <div className="panel-header">
        <h2>Before / After Simulation</h2>
        <span>{formatBytes(simulatedReclaimed)} simulated reclaimed</span>
      </div>
      <label className="simulation-slider">
        <span>{simulationPercent}% of safe duplicate reclaim simulated. {overlapReclaimableBytes > 0 ? "Folder-specific overlap data is used where available." : "No folder overlap data yet, so reclaim is distributed by folder size."}</span>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={simulationPercent}
          onChange={(event) => setSimulationPercent(Number(event.currentTarget.value))}
        />
      </label>
      <div className="simulation-grid">
        <div>
          <strong>Before</strong>
          <TreemapCanvas files={files} folders={currentFolders} nativeRuntime={nativeRuntime} />
        </div>
        <div>
          <strong>After</strong>
          <TreemapCanvas files={files} folders={simulatedFolders} nativeRuntime={nativeRuntime} />
        </div>
      </div>
      {simulationChanges.length > 0 && (
        <div className="simulation-deltas">
          {simulationChanges.map((change) => (
            <div key={change.path}>
              <span>{change.label}</span>
              <strong>-{formatBytes(change.bytes)}</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FilePreviewWorkbench({
  files,
  nativeRuntime,
  emptyLabel,
  statusForFile,
  renderFileActions,
}: {
  files: PreviewableFile[];
  nativeRuntime: boolean;
  emptyLabel: string;
  statusForFile?: (file: PreviewableFile) => { label: string; tone: "safe" | "medium" | "risky" | "manual" };
  renderFileActions?: (file: PreviewableFile, preview: () => void) => React.ReactNode;
}) {
  const [selectedPath, setSelectedPath] = useState(files[0]?.path ?? "");

  useEffect(() => {
    if (files.length === 0) {
      setSelectedPath("");
      return;
    }
    if (!files.some((file) => file.path === selectedPath)) {
      setSelectedPath(files[0].path);
    }
  }, [files, selectedPath]);

  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  if (!selectedFile) {
    return <div className="empty-state compact">{emptyLabel}</div>;
  }

  const canRenderPhoto = nativeRuntime && selectedFile.category === "photos";
  const canRenderVideo = nativeRuntime && selectedFile.category === "videos";
  const canRenderAudio = nativeRuntime && selectedFile.category === "music";
  const canRenderInline = canRenderPhoto || canRenderVideo || canRenderAudio;

  return (
    <div className="file-preview-workbench">
      <div className="file-preview-list" aria-label="Files in this review set">
        <div className="file-preview-list-header" aria-hidden="true">
          <span>File</span>
          <span>Size</span>
          <span>Modified</span>
          <span>Actions</span>
        </div>
        <ScrollableRows compact>
          {files.map((file) => {
            const status = statusForFile?.(file);
            const preview = () => setSelectedPath(file.path);

            return (
              <div
                className={`file-preview-row ${file.path === selectedFile.path ? "active" : ""}`}
                key={file.path}
                onClick={preview}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    preview();
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <span className="file-preview-row-name">
                  {fileTypeIcon(file)}
                  <span>
                    <strong>{file.name}</strong>
                    <small>{file.path}</small>
                    <small>{file.folderPath}</small>
                    <span className="file-preview-badges">
                      <span>{categories[file.category].label}</span>
                      <span>{file.extension}</span>
                      {file.hashMatchType && <span>{file.hashMatchType}</span>}
                      {typeof file.confidence === "number" && <span>{Math.round(file.confidence * 100)}% confidence</span>}
                      {status && <span className={`status-pill ${status.tone}`}>{status.label}</span>}
                    </span>
                  </span>
                </span>
                <strong>{formatBytes(file.size)}</strong>
                <small>{file.modifiedAt ? formatDate(file.modifiedAt) : "-"}</small>
                {renderFileActions && (
                  <span className="file-preview-row-actions">
                    {renderFileActions(file, preview)}
                  </span>
                )}
              </div>
            );
          })}
        </ScrollableRows>
      </div>
      <aside className="file-preview-pane">
        <div className="file-preview-frame">
          {canRenderPhoto && <img src={convertFileSrc(selectedFile.path)} alt="" loading="lazy" />}
          {canRenderVideo && <video src={convertFileSrc(selectedFile.path)} controls preload="metadata" />}
          {canRenderAudio && <audio src={convertFileSrc(selectedFile.path)} controls preload="metadata" />}
          {!canRenderInline && (
            <div className="file-preview-fallback">
              {fileTypeIcon(selectedFile, 28)}
              <strong>{nativeRuntime ? "Preview not available" : "Native preview required"}</strong>
              <span>{categories[selectedFile.category].label}</span>
            </div>
          )}
        </div>
        <div className="file-preview-meta">
          <strong title={selectedFile.name}>{selectedFile.name}</strong>
          <span>{selectedFile.folderPath}</span>
          <span>{selectedFile.hashMatchType ?? "size"} match - {Math.round((selectedFile.confidence ?? 0) * 100)}% confidence</span>
          <span>{formatBytes(selectedFile.size)} · {selectedFile.extension}</span>
          <span>{selectedFile.modifiedAt ? formatDate(selectedFile.modifiedAt) : "No modified date"}</span>
          <small title={selectedFile.path}>{selectedFile.path}</small>
        </div>
        {renderFileActions && (
          <div className="file-preview-actions">
            {renderFileActions(selectedFile, () => setSelectedPath(selectedFile.path))}
          </div>
        )}
      </aside>
    </div>
  );
}

function fileTypeIcon(file: PreviewableFile, size = 16) {
  if (file.category === "photos") return <FileImage size={size} />;
  if (file.category === "videos") return <FileVideo size={size} />;
  if (file.category === "music") return <FileAudio size={size} />;
  return <FileText size={size} />;
}

function suggestDuplicateKeepFile(files: NativeDuplicateFile[]) {
  if (files.length === 0) return null;

  const maxModified = Math.max(...files.map((file) => file.modified_at ?? 0));
  const scored = files.map((file) => {
    const path = file.path.toLowerCase();
    const organizedFolder = /photos|pictures|sorted|archive|library|media|documents/.test(path);
    const temporaryFolder = /downloads|temp|tmp|cache|trash|recycle/.test(path);
    const newestScore = maxModified > 0 && file.modified_at === maxModified ? 40 : 0;
    const organizedScore = organizedFolder ? 24 : 0;
    const temporaryPenalty = temporaryFolder ? -36 : 0;
    const pathScore = Math.max(0, 20 - Math.floor(file.path.length / 12));
    const score = newestScore + organizedScore + temporaryPenalty + pathScore;
    const reasonParts = [
      newestScore > 0 ? "newest copy" : "",
      organizedFolder ? "organized folder" : "",
      temporaryFolder ? "temporary folder penalty considered" : "",
      pathScore > 0 ? "cleaner path" : "",
    ].filter(Boolean);

    return {
      file,
      score,
      reason: reasonParts.length > 0
        ? `Reason: ${reasonParts.join(", ")}.`
        : "Reason: stable path and matching duplicate metadata.",
    };
  });

  return scored.sort((a, b) => {
    return b.score - a.score
      || (b.file.modified_at ?? 0) - (a.file.modified_at ?? 0)
      || a.file.path.length - b.file.path.length
      || a.file.path.localeCompare(b.file.path);
  })[0];
}

function buildDuplicateRecycleOperation(groupId: number, files: NativeDuplicateFile[], keepPath: string): NonNullable<StagedAction["operation"]> {
  const keepFile = files.find((file) => file.path === keepPath);
  const removeFiles = files.filter((file) => file.path !== keepPath);

  return {
    kind: "recycleFiles",
    keepPath,
    removePaths: removeFiles.map((file) => file.path),
    duplicateGroupId: groupId,
    keepFileId: keepFile?.id,
    removeFileIds: removeFiles.map((file) => file.id),
    keepName: keepFile?.name ?? lastSegment(keepPath),
    recycleFiles: removeFiles.map((file) => ({
      id: file.id,
      path: file.path,
      name: file.name,
      size: file.size,
    })),
    affectedFolders: summarizeOperationFolders(files),
    expectedFiles: files.map((file) => ({
      path: file.path,
      size: file.size,
      modifiedAt: file.modified_at,
    })),
    rollbackHint: "Files are moved to the OS Recycle Bin when available; restore from there before emptying it.",
  };
}

function summarizeOperationFolders(files: NativeDuplicateFile[]) {
  const folders = new Map<string, { path: string; files: number; bytes: number }>();

  for (const file of files) {
    const current = folders.get(file.folder_path) ?? {
      path: file.folder_path,
      files: 0,
      bytes: 0,
    };
    current.files += 1;
    current.bytes += file.size;
    folders.set(file.folder_path, current);
  }

  return [...folders.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes || a.path.localeCompare(b.path));
}

function buildDuplicateFolderRelationship(files: NativeDuplicateFile[]) {
  if (files.length === 0) return null;

  const byFolder = new Map<string, { path: string; files: number; bytes: number; latestModified: number }>();
  for (const file of files) {
    const current = byFolder.get(file.folder_path) ?? {
      path: file.folder_path,
      files: 0,
      bytes: 0,
      latestModified: 0,
    };
    current.files += 1;
    current.bytes += file.size;
    current.latestModified = Math.max(current.latestModified, file.modified_at ?? 0);
    byFolder.set(file.folder_path, current);
  }

  const folders = [...byFolder.values()].sort((a, b) => {
    return b.files - a.files || b.bytes - a.bytes || a.path.localeCompare(b.path);
  });
  const likelySource = [...folders].sort((a, b) => {
    return b.latestModified - a.latestModified || a.path.length - b.path.length || a.path.localeCompare(b.path);
  })[0];
  const likelyDuplicate = folders.find((folder) => folder.path !== likelySource.path) ?? likelySource;
  const message = folders.length > 1
    ? `Most copies are between ${lastSegment(likelySource.path)} and ${lastSegment(likelyDuplicate.path)}.`
    : `All visible copies are currently inside ${lastSegment(likelySource.path)}.`;

  return {
    folderCount: folders.length,
    folders,
    likelySource,
    likelyDuplicate,
    message,
  };
}

function MediaPreviewPanel({ file, nativeRuntime }: { file: ScanState["largestFiles"][number] | null; nativeRuntime: boolean }) {
  if (!file) {
    return (
      <aside className="media-preview-panel empty">
        <strong>Select a dot</strong>
        <span>Zoom clusters until individual media files are visible, then select one to preview.</span>
      </aside>
    );
  }

  const canRenderPhoto = nativeRuntime && file.category === "photos";
  const canRenderVideo = nativeRuntime && file.category === "videos";
  const canRenderAudio = nativeRuntime && file.category === "music";

  return (
    <aside className="media-preview-panel">
      <div className="media-preview-frame">
        {canRenderPhoto && <img src={convertFileSrc(file.path)} alt="" loading="lazy" />}
        {canRenderVideo && <video src={convertFileSrc(file.path)} controls preload="metadata" />}
        {canRenderAudio && <audio src={convertFileSrc(file.path)} controls preload="metadata" />}
        {!canRenderPhoto && !canRenderVideo && !canRenderAudio && <span>{categories[file.category].label}</span>}
      </div>
      <strong>{lastSegment(file.path)}</strong>
      <span>{formatDate(Math.floor(file.modified / 1000))} - {formatBytes(file.bytes)}</span>
      <small>{file.path}</small>
    </aside>
  );
}

function timelineLane(category: CategoryKey) {
  if (category === "photos") return 25;
  if (category === "videos") return 45;
  if (category === "music") return 65;
  if (category === "documents") return 82;
  return 50;
}

type TimelineCluster = {
  start: number;
  end: number;
  center: number;
  files: ScanState["largestFiles"];
};

function buildTimelineClusters(files: ScanState["largestFiles"], start: number, end: number): TimelineCluster[] {
  const bucketCount = 44;
  const span = Math.max(end - start, 1);
  const buckets = new Map<number, ScanState["largestFiles"]>();

  for (const file of files) {
    const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(((file.modified - start) / span) * bucketCount)));
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), file]);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucketFiles]) => {
      const sorted = [...bucketFiles].sort((a, b) => a.modified - b.modified);
      const clusterStart = sorted[0].modified;
      const clusterEnd = sorted[sorted.length - 1].modified;
      return {
        start: clusterStart,
        end: clusterEnd,
        center: sorted.reduce((sum, file) => sum + file.modified, 0) / sorted.length,
        files: sorted,
      };
    });
}

function expandTimelineRange(start: number, end: number, minTime: number, maxTime: number) {
  const span = Math.max(end - start, 1000 * 60 * 60 * 24);
  const padding = span * 0.35;
  return clampTimelineRange(start - padding, end + padding, minTime, maxTime);
}

function panTimelineRange(start: number, end: number, fraction: number, minTime: number, maxTime: number) {
  const span = Math.max(end - start, 1);
  const delta = span * fraction;
  return clampTimelineRange(start + delta, end + delta, minTime, maxTime);
}

function clampTimelineRange(start: number, end: number, minTime: number, maxTime: number) {
  const fullSpan = Math.max(maxTime - minTime, 1);
  const span = Math.min(Math.max(end - start, 1), fullSpan);
  let nextStart = start;
  let nextEnd = start + span;

  if (nextStart < minTime) {
    nextStart = minTime;
    nextEnd = minTime + span;
  }

  if (nextEnd > maxTime) {
    nextEnd = maxTime;
    nextStart = maxTime - span;
  }

  return { start: nextStart, end: nextEnd };
}

function SmartSuggestedMoves({ scan, onStage }: { scan: ScanState; onStage: (suggestion: MoveSuggestion) => void }) {
  const moveCategories: CategoryKey[] = ["photos", "videos", "music", "documents"];
  const suggestions = moveCategories
    .map((category) => {
      const folders = scan.folders
        .filter((folder) => folder.categories[category] > 0)
        .sort((a, b) => b.categories[category] - a.categories[category]);
      const bytes = folders.reduce((sum, folder) => sum + folder.categories[category], 0);
      const sourceFolders = folders.slice(0, 4).map((folder) => ({
        path: folder.path,
        bytes: folder.categories[category],
        files: folder.files,
      }));
      const yearBuckets = buildSuggestionYearBuckets(scan.largestFiles, category);
      return {
        category,
        folderCount: folders.length,
        bytes,
        destination: yearBuckets.length > 0 ? `${categories[category].label}/By-Year/` : `${categories[category].label}/Review/`,
        sourceFolders,
        yearBuckets,
      };
    })
    .filter((suggestion) => suggestion.folderCount > 1 && suggestion.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="suggested-moves" aria-label="Smart suggested moves">
      <h3>Suggested Moves</h3>
      {suggestions.map((suggestion) => {
        const sourcePreview = suggestion.sourceFolders.slice(0, 3);
        const remainingSources = Math.max(0, suggestion.sourceFolders.length - sourcePreview.length);
        const yearPreview = suggestion.yearBuckets.slice(0, 3);
        const remainingYears = Math.max(0, suggestion.yearBuckets.length - yearPreview.length);

        return (
          <div className="suggested-move" key={suggestion.category}>
            <span style={{ background: categories[suggestion.category].color }} />
            <div className="suggested-move-body">
              <div className="suggested-move-header">
                <div>
                  <strong>{categories[suggestion.category].label}</strong>
                  <small>{formatBytes(suggestion.bytes)} across {formatCount(suggestion.folderCount)} folders</small>
                </div>
                <small className="suggested-destination">Dest: {suggestion.destination}</small>
              </div>
              <div className="suggested-move-grid">
                <div className="suggested-move-block">
                  <small className="suggested-label">Top source folders</small>
                  <div className="suggested-move-preview">
                    {sourcePreview.map((folder) => (
                      <small key={folder.path} title={folder.path}>
                        {lastSegment(folder.path)} · {formatBytes(folder.bytes)}
                      </small>
                    ))}
                    {remainingSources > 0 && (
                      <small className="muted">+{formatCount(remainingSources)} more</small>
                    )}
                  </div>
                </div>
                <div className="suggested-move-block">
                  <small className="suggested-label">Year buckets</small>
                  <div className="suggested-move-preview">
                    {yearPreview.length > 0 ? (
                      <>
                        {yearPreview.map((bucket) => (
                          <small key={bucket.year}>
                            {bucket.year} · {formatCount(bucket.files)}
                          </small>
                        ))}
                        {remainingYears > 0 && (
                          <small className="muted">+{formatCount(remainingYears)} more</small>
                        )}
                      </>
                    ) : (
                      <small className="muted">No date buckets yet</small>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <IconButton title={`Stage ${categories[suggestion.category].label} move review`} onClick={() => onStage(suggestion)}>
              <MoveRight size={16} />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

function buildSuggestionYearBuckets(files: ScanState["largestFiles"], category: CategoryKey) {
  const buckets = new Map<string, number>();
  for (const file of files) {
    if (file.category !== category || file.modified <= 0) continue;
    const year = new Date(file.modified).getFullYear();
    if (!Number.isFinite(year) || year < 1980) continue;
    buckets.set(String(year), (buckets.get(String(year)) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .map(([year, count]) => ({ year, files: count }))
    .sort((a, b) => Number(b.year) - Number(a.year))
    .slice(0, 5);
}

function ShortcutHelp() {
  const shortcuts = [
    { keys: "/", label: "Focus search" },
    { keys: "1-0", label: "Switch category filters" },
    { keys: "W", label: "Show workspace" },
    { keys: "I", label: "Show index library" },
    { keys: "Esc", label: "Clear focus and batch selection" },
    { keys: "? / H", label: "Toggle this shortcut reference" },
  ];

  return (
    <section className="shortcut-help" aria-label="Keyboard shortcut reference">
      {shortcuts.map((shortcut) => (
        <span key={shortcut.keys}>
          <kbd>{shortcut.keys}</kbd>
          {shortcut.label}
        </span>
      ))}
    </section>
  );
}

function IconButton({
  children,
  className = "",
  disabled = false,
  title,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button className={`icon-cta ${className}`} type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Treemap({
  files,
  folders,
  nativeRuntime,
  onSelect,
}: {
  files: ScanState["largestFiles"];
  folders: Array<FolderStats & { displayBytes: number }>;
  nativeRuntime: boolean;
  onSelect: (folder: FolderStats & { displayBytes: number }) => void;
}) {
  if (folders.length === 0) {
    return <div className="treemap-empty">No indexed folders yet</div>;
  }

  return <TreemapCanvas files={files} folders={folders} nativeRuntime={nativeRuntime} onSelect={onSelect} />;
}

function ScrollableRows({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return <div className={`scroll-rows ${compact ? "compact" : ""}`}>{children}</div>;
}

function postWorker(worker: Worker | null, message: ScanWorkerCommand) {
  worker?.postMessage(message);
}

function getProgress(scan: ScanState) {
  if (scan.totalFiles === 0) return 0;
  return Math.min(100, (scan.processedFiles / scan.totalFiles) * 100);
}

function formatDate(epochSeconds: number) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(epochSeconds * 1000));
}

function formatIndexDate(epochSeconds: number | null | undefined) {
  if (!epochSeconds) return "Never";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(epochSeconds * 1000));
}

function parseMegabytes(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 1024 * 1024);
}

function normalizePath(path: string) {
  return path.replace(/[\\/]+$/, "");
}

function parentPath(path: string) {
  const normalized = normalizePath(path);
  const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
  return index > 0 ? normalized.slice(0, index) : null;
}

function isDescendantPath(path: string, parent: string) {
  const normalizedPath = normalizePath(path);
  const normalizedParent = normalizePath(parent);
  if (normalizedPath === normalizedParent) return false;
  return normalizedPath.startsWith(`${normalizedParent}\\`) || normalizedPath.startsWith(`${normalizedParent}/`);
}

function isEditableShortcutTarget(target: HTMLElement | null) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

createRoot(document.getElementById("root")!).render(<App />);
