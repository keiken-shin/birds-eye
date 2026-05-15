import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ChevronLeft,
  CopyCheck,
  Database,
  FolderOpen,
  FolderSearch,
  Pause,
  Play,
  Radar,
  Search,
  Settings,
  Square,
  Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import {
  categories,
  formatBytes,
  formatCount,
  initialScanState,
  lastSegment,
  type CategoryKey,
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
  searchNativeIndex,
  startNativeScan,
  nativeJobEvents,
  type NativeDuplicateFile,
  type NativeIndexEntry,
  type NativeJobEvent,
  type NativeSearchResult,
} from "./nativeClient";
import { parentPath, isDescendantPath } from "./utils/pathUtils";
import {
  nativeJobEventFingerprint,
  mergeNativeOverview,
  mediaKindFromCategory,
} from "./utils/scanUtils";
import { getProgress, makeDuplicateHint, makeCategoryHint, formatDate } from "./utils/displayUtils";
import { TreemapCanvas } from "./TreemapCanvas";
import logoUrl from "./assets/birds-eye-logo.svg";
import "./styles.css";

type NativeEventState = {
  maxFilesScanned: number;
  maxBytesScanned: number;
  seenFingerprints: Set<string>;
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nativeJobRef = useRef<{ jobId: number; indexPath: string } | null>(null);
  const isWaitingForJobId = useRef(false);
  const nativeEventStateRef = useRef(new Map<number, NativeEventState>());
  const [scan, setScan] = useState<ScanState>(initialScanState);
  const [filter, setFilter] = useState<CategoryKey | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NativeSearchResult[]>([]);
  const [currentIndexPath, setCurrentIndexPath] = useState<string | null>(null);
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  const [duplicateFiles, setDuplicateFiles] = useState<NativeDuplicateFile[]>([]);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<number | null>(null);
  const [savedIndexes, setSavedIndexes] = useState<NativeIndexEntry[]>([]);
  const [nativeRuntime, setNativeRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("Browser preview");

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

  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    if (!nativeRuntime || !currentIndexPath) {
      const browserMatches = scan.largestFiles
        .filter((file) => file.path.toLowerCase().includes(trimmedQuery.toLowerCase()))
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
      void searchNativeIndex(currentIndexPath, trimmedQuery, 24)
        .then(setSearchResults)
        .catch((error) => {
          setRuntimeMessage(error instanceof Error ? error.message : "Search failed");
          setSearchResults([]);
        });
    }, 180);

    return () => window.clearTimeout(handle);
  }, [currentIndexPath, nativeRuntime, scan.largestFiles, searchQuery]);

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

      // Block pushed events until we've assigned the job ref and drained buffered events.
      // Events can be emitted before startNativeScan resolves, so set this flag first.
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
        // Only accept pushed events after the buffered replay has drained.
        // handleNativeJobEvent is still monotonic, so any push/replay interleaving
        // or non-adjacent duplicate that slips through cannot move progress backward.
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

  function resetNativeEventState() {
    nativeEventStateRef.current.clear();
  }

  function clearNativeEventState(jobId: number) {
    nativeEventStateRef.current.delete(jobId);
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
    isWaitingForJobId.current = false;
    resetNativeEventState();
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
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <img src={logoUrl} alt="" />
          <span>Birds Eye</span>
        </div>
        <nav>
          <a className="active" href="#dashboard"><Activity size={18} />Dashboard</a>
          <a href="#scan"><Radar size={18} />Scan Manager</a>
          <a href="#treemap"><FolderSearch size={18} />Treemap</a>
          <a href="#data"><Database size={18} />Index</a>
          <a href="#settings"><Settings size={18} />Settings</a>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar" id="dashboard">
          <div>
            <p className="eyebrow">Offline storage intelligence</p>
            <h1>Understand where your disk space went.</h1>
          </div>
          <div className="action-row">
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              multiple
              onChange={(event) => handleFiles(event.currentTarget.files)}
            />
            <button className="primary-action" type="button" onClick={openFolderPicker}>
              <FolderOpen size={18} /> Choose Folder
            </button>
            {scan.status === "scanning" && (
              <button className="ghost-action" type="button" onClick={pauseScan} title="Pause scan">
                <Pause size={18} />
              </button>
            )}
            {scan.status === "paused" && (
              <button className="ghost-action" type="button" onClick={resumeScan} title="Resume scan">
                <Play size={18} />
              </button>
            )}
            {(scan.status === "scanning" || scan.status === "paused") && (
              <button className="ghost-action danger" type="button" onClick={cancelScan} title="Cancel scan">
                <Square size={16} />
              </button>
            )}
            {scan.status !== "idle" && (
              <button className="ghost-action" type="button" onClick={clearScan} title="Clear results">
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </header>

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

        <section className="analysis-layout" id="treemap">
          <div className="treemap-panel">
            <div className="panel-header">
              <h2>Space Distribution</h2>
              <span>{focusedFolder ? lastSegment(focusedFolder) : filteredFolders.length > 0 ? "Largest folders by selected category" : "Select a folder to begin"}</span>
            </div>
            {focusedFolder && (
              <div className="breadcrumb-row">
                <button type="button" onClick={() => setFocusedFolder(parentPath(focusedFolder))} title="Go up one folder">
                  <ChevronLeft size={16} />
                </button>
                <span>{focusedFolder}</span>
                <button type="button" onClick={() => setFocusedFolder(null)}>Root</button>
              </div>
            )}
            <Treemap folders={filteredFolders} onSelect={(folder) => setFocusedFolder(folder.path)} />
          </div>

          <aside className="recommendations">
            <h2>Cleanup Intelligence</h2>
            <Recommendation text={makeDuplicateHint(scan)} />
            <Recommendation text={makeCategoryHint(scan, "installers", "installer cache")} />
            <Recommendation text={makeCategoryHint(scan, "archives", "archive payloads")} />
            <Recommendation text={makeCategoryHint(scan, "videos", "video library")} />
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
                <div className="folder-row" key={folder.path}>
                  <span>{folder.path}</span>
                  <strong>{formatBytes(folder.bytes)}</strong>
                  <small>{formatCount(folder.files)} files</small>
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
              type="search"
              value={searchQuery}
              placeholder="Search indexed paths"
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
          </label>
          {searchQuery.trim().length < 2 ? (
            <div className="empty-state compact">Enter at least two characters to search the current index.</div>
          ) : searchResults.length === 0 ? (
            <div className="empty-state compact">No indexed files match this search.</div>
          ) : (
            <ScrollableRows compact>
              {searchResults.map((file) => (
                <div className="folder-row file-row" key={file.path}>
                  <span>{file.path}</span>
                  <strong>{formatBytes(file.size)}</strong>
                  <small>{file.extension ?? "(none)"}</small>
                </div>
              ))}
            </ScrollableRows>
          )}
        </section>

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
                  <div className="folder-row file-row" key={file.path}>
                    <span>{file.path}</span>
                    <strong>{formatBytes(file.bytes)}</strong>
                    <small>{file.extension}</small>
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

        <section className="folder-table">
          <div className="panel-header">
            <h2>Duplicate Candidates</h2>
            <span><CopyCheck size={14} /> Size + partial + full hash</span>
          </div>
          <p className="section-note">Duplicate groups start by identical file size, then matching candidates are refined with partial hashes and full-file hashes. A 100% confidence group means matching full hashes.</p>
          {scan.duplicateCandidates.length === 0 ? (
            <div className="empty-state compact">Files with identical sizes will appear here as duplicate candidates.</div>
          ) : (
            <ScrollableRows compact>
              {scan.duplicateCandidates.map((candidate) => (
                <button
                  className={`duplicate-row ${selectedDuplicateGroup === candidate.id ? "active" : ""}`}
                  key={candidate.id ?? candidate.size}
                  type="button"
                  onClick={() => void selectDuplicateCandidate(candidate)}
                >
                  <div>
                    <strong>{formatBytes(candidate.reclaimableBytes)} reclaimable</strong>
                    <span>{formatCount(candidate.files)} files at {formatBytes(candidate.size)} each</span>
                  </div>
                  <small>{candidate.samples.join(" | ")}</small>
                </button>
              ))}
            </ScrollableRows>
          )}
          {duplicateFiles.length > 0 && (
            <div className="duplicate-file-list">
              {duplicateFiles.map((file) => (
                <div className="folder-row file-row" key={file.path}>
                  <span>{file.path}</span>
                  <strong>{formatBytes(file.size)}</strong>
                  <small>{file.modified_at ? formatDate(file.modified_at) : "-"}</small>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="folder-table" id="settings">
          <div className="panel-header">
            <h2>Saved Indexes</h2>
            <span><Database size={14} /> {nativeRuntime ? `${formatCount(savedIndexes.length)} local` : "Native only"}</span>
          </div>
          {!nativeRuntime ? (
            <div className="empty-state compact">Saved indexes are available in the desktop app.</div>
          ) : savedIndexes.length === 0 ? (
            <div className="empty-state compact">Scanned folders will appear here for revisiting, rescanning, or removing their local index.</div>
          ) : (
            <ScrollableRows compact>
              {savedIndexes.map((entry) => (
                <div className="index-row" key={entry.index_path}>
                  <div>
                    <strong>{entry.root_path ?? "Unknown root"}</strong>
                    <span>{entry.last_status ?? "unknown"} - {formatBytes(entry.bytes_scanned)} - {formatCount(entry.files_scanned)} files</span>
                  </div>
                  <button type="button" onClick={() => void openSavedIndex(entry)}>View</button>
                  <button type="button" onClick={() => void rescanSavedIndex(entry)}>Rescan</button>
                  <button className="danger-text" type="button" onClick={() => void removeSavedIndex(entry)}>Delete</button>
                </div>
              ))}
            </ScrollableRows>
          )}
        </section>
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
      const files = await queryNativeDuplicateFiles(currentIndexPath, candidate.id, 24);
      setDuplicateFiles(files);
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Duplicate details failed");
    }
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
    window.location.hash = "dashboard";
  }

  async function rescanSavedIndex(entry: NativeIndexEntry) {
    if (!entry.root_path) return;

    stopWorker();
    setFilter("all");
    setFocusedFolder(null);
    setSearchQuery("");
    setSearchResults([]);
    setCurrentIndexPath(null);
    setDuplicateFiles([]);
    setSelectedDuplicateGroup(null);
    setRuntimeMessage("Native rescan starting");

    // Block pushed events until we've assigned the job ref and drained buffered events.
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
      // Only accept pushed events after the buffered replay has drained.
      // handleNativeJobEvent is still monotonic, so any push/replay interleaving
      // or non-adjacent duplicate that slips through cannot move progress backward.
      isWaitingForJobId.current = false;
    }
    if (nativeJobRef.current?.jobId === jobId) {
      setRuntimeMessage("Native index mode");
    }

    window.location.hash = "scan";
  }

  async function removeSavedIndex(entry: NativeIndexEntry) {
    await deleteNativeIndex(entry.index_path);
    if (currentIndexPath === entry.index_path) {
      clearScan();
    }
    await refreshSavedIndexes();
  }
}

function Treemap({ folders, onSelect }: { folders: Array<FolderStats & { displayBytes: number }>; onSelect: (folder: FolderStats & { displayBytes: number }) => void }) {
  if (folders.length === 0) {
    return <div className="treemap-empty">No indexed folders yet</div>;
  }

  return <TreemapCanvas folders={folders} onSelect={onSelect} />;
}

function ScrollableRows({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return <div className={`scroll-rows ${compact ? "compact" : ""}`}>{children}</div>;
}

function Recommendation({ text }: { text: string }) {
  return <button type="button">{text}</button>;
}

function postWorker(worker: Worker | null, message: ScanWorkerCommand) {
  worker?.postMessage(message);
}

createRoot(document.getElementById("root")!).render(<App />);
