import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChevronLeft,
  CopyCheck,
  Database,
  Eye,
  ExternalLink,
  FolderOpen,
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
  emptyCategories,
  emptyFolderCategories,
  formatBytes,
  formatCount,
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
  revealNativePath,
  searchNativeIndex,
  startNativeScan,
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
  confidence: "Safe" | "Medium" | "Manual review";
  bytes: number;
  reason: string;
};

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
  const [savedIndexes, setSavedIndexes] = useState<NativeIndexEntry[]>([]);
  const [stagedActions, setStagedActions] = useState<StagedAction[]>([]);
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
            <h2>Action Heatmap</h2>
            <ActionHeatmap scan={scan} />
          </aside>
        </section>

        <section className="folder-table">
          <div className="panel-header">
            <h2>Scan Manager</h2>
            <span>{scan.status}</span>
          </div>
          <div className="scan-manager-grid">
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
          </div>
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

        <section className="folder-table">
          <div className="panel-header">
            <h2>Duplicate Candidates</h2>
            <span><CopyCheck size={14} /> Size + partial + full hash</span>
          </div>
          <p className="section-note">Duplicate groups start by identical file size, then matching candidates are refined with partial hashes and full-file hashes. A 100% confidence group means matching full hashes.</p>
          <DuplicateOverlapGraph overlaps={scan.duplicateOverlaps} />
          {scan.duplicateCandidates.length === 0 ? (
            <div className="empty-state compact">Files with identical sizes will appear here as duplicate candidates.</div>
          ) : (
            <ScrollableRows compact>
              {scan.duplicateCandidates.map((candidate) => (
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
                    <strong>{formatBytes(candidate.reclaimableBytes)} reclaimable</strong>
                    <span>{formatCount(candidate.files)} files at {formatBytes(candidate.size)} each</span>
                  </div>
                  <small>{candidate.samples.join(" | ")}</small>
                  <span className="duplicate-actions">
                    <IconButton title="Stage exact duplicate review" onClick={(event) => stageDuplicateAction(event, candidate)}>
                      <CopyCheck size={16} />
                    </IconButton>
                  </span>
                </div>
              ))}
            </ScrollableRows>
          )}
          {duplicateFiles.length > 0 && (
            <div className="duplicate-file-list">
              {duplicateFiles.map((file) => (
                <div className="folder-row file-row action-row-grid" key={file.path}>
                  <span>{file.path}</span>
                  <strong>{formatBytes(file.size)}</strong>
                  <small>{file.modified_at ? formatDate(file.modified_at) : "-"}</small>
                  <IconButton title="Open in Explorer" onClick={() => void revealPath(file.path)}>
                    <ExternalLink size={16} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </section>

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
              </div>
              <ScrollableRows compact>
                {stagedActions.map((action) => (
                  <div className="staged-row" key={action.id}>
                    <div>
                      <strong>{action.label}</strong>
                      <span>{action.reason}</span>
                    </div>
                    <small>{action.confidence}</small>
                    <strong>{formatBytes(action.bytes)}</strong>
                  </div>
                ))}
              </ScrollableRows>
            </>
          )}
        </section>

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
            <ScrollableRows compact>
              {savedIndexes.map((entry) => (
                <div className="index-row" key={entry.index_path}>
                  <div>
                    <strong>{entry.root_path ?? "Unknown root"}</strong>
                    <span>{entry.last_status ?? "unknown"} - {formatBytes(entry.bytes_scanned)} - {formatCount(entry.files_scanned)} files</span>
                  </div>
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

  function stageDuplicateAction(event: React.MouseEvent, candidate: ScanState["duplicateCandidates"][number]) {
    event.stopPropagation();
    const confidenceScore = candidate.confidenceScore ?? 0;
    const confidence = confidenceScore >= 1 ? "Safe" : confidenceScore >= 0.65 ? "Medium" : "Manual review";
    const id = `duplicate-${candidate.id ?? candidate.size}`;
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
  }

  async function removeSavedIndex(entry: NativeIndexEntry) {
    await deleteNativeIndex(entry.index_path);
    if (currentIndexPath === entry.index_path) {
      clearScan();
    }
    await refreshSavedIndexes();
  }
}

function mergeNativeOverview(scan: ScanState, overview: NativeIndexOverview): ScanState {
  const folderCategoryMap = new Map<string, ReturnType<typeof emptyFolderCategories>>();
  for (const media of overview.folder_media) {
    const categories = folderCategoryMap.get(media.folder_path) ?? emptyFolderCategories();
    categories[categoryFromMediaKind(media.media_kind)] += media.total_bytes;
    folderCategoryMap.set(media.folder_path, categories);
  }

  const folders = overview.folders.map((folder) => ({
    path: folder.path,
    files: folder.total_files,
    bytes: folder.total_bytes,
    categories: folderCategoryMap.get(folder.path) ?? emptyFolderCategories(),
  }));
  const largestFiles = overview.files.map((file) => ({
    path: file.path,
    name: lastSegment(file.path),
    folder: file.path.includes("\\") ? file.path.slice(0, file.path.lastIndexOf("\\")) : file.path.slice(0, file.path.lastIndexOf("/")),
    extension: file.extension ?? "(none)",
    bytes: file.size,
    category: categoryFromMediaKind(file.media_kind),
    modified: 0,
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
    reclaimableBytes: group.reclaimable_bytes,
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

function mediaKindFromCategory(category: CategoryKey) {
  if (category === "photos") return "photo";
  if (category === "videos") return "video";
  if (category === "archives") return "archive";
  if (category === "documents") return "document";
  if (category === "installers") return "installer";
  if (category === "models") return "model";
  return category === "other" ? "other" : category;
}

function DuplicateOverlapGraph({ overlaps }: { overlaps: DuplicateOverlap[] }) {
  const topOverlaps = overlaps.slice(0, 8);
  if (topOverlaps.length === 0) {
    return null;
  }

  const folderWeights = new Map<string, number>();
  for (const overlap of topOverlaps) {
    folderWeights.set(overlap.folderA, (folderWeights.get(overlap.folderA) ?? 0) + overlap.reclaimableBytes);
    folderWeights.set(overlap.folderB, (folderWeights.get(overlap.folderB) ?? 0) + overlap.reclaimableBytes);
  }

  const folders = [...folderWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([path, bytes], index, list) => {
      const angle = list.length === 1 ? 0 : (Math.PI * 2 * index) / list.length - Math.PI / 2;
      return {
        path,
        bytes,
        x: 50 + Math.cos(angle) * 32,
        y: 50 + Math.sin(angle) * 32,
      };
    });
  const folderByPath = new Map(folders.map((folder) => [folder.path, folder]));
  const maxBytes = Math.max(...topOverlaps.map((overlap) => overlap.reclaimableBytes), 1);

  return (
    <div className="overlap-graph" aria-label="Duplicate overlap graph">
      <div className="overlap-canvas">
        <svg viewBox="0 0 100 100" role="img" aria-label="Folders connected by shared duplicate files">
          {topOverlaps.map((overlap) => {
            const source = folderByPath.get(overlap.folderA);
            const target = folderByPath.get(overlap.folderB);
            if (!source || !target) return null;
            const width = 1.5 + (overlap.reclaimableBytes / maxBytes) * 7;
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
            const radius = 7 + Math.min(11, Math.sqrt(folder.bytes / Math.max(maxBytes, 1)) * 9);
            return (
              <g key={folder.path}>
                <circle cx={folder.x} cy={folder.y} r={radius} />
                <text x={folder.x} y={folder.y + radius + 5}>{lastSegment(folder.path)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="overlap-list">
        {topOverlaps.slice(0, 4).map((overlap) => (
          <div className="overlap-pair" key={`${overlap.folderA}-${overlap.folderB}`}>
            <strong>{formatBytes(overlap.reclaimableBytes)}</strong>
            <span>{lastSegment(overlap.folderA)} <span aria-hidden="true">/</span> {lastSegment(overlap.folderB)}</span>
            <small>{formatCount(overlap.sharedGroups)} groups, {formatCount(overlap.sharedFiles)} files</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActionHeatmap({ scan }: { scan: ScanState }) {
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
              <span
                className="heatmap-cell"
                key={cell.key}
                style={{ "--heat": intensity.toFixed(3) } as React.CSSProperties}
                title={`${cell.label}: ${formatBytes(cell.bytes)} in ${row.folder.path}`}
              >
                {cell.bytes > 0 ? formatBytes(cell.bytes) : "-"}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function IconButton({
  children,
  className = "",
  title,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  title: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button className={`icon-cta ${className}`} type="button" title={title} aria-label={title} onClick={onClick}>
      {children}
    </button>
  );
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

createRoot(document.getElementById("root")!).render(<App />);
