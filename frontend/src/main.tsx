import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ChevronLeft,
  CopyCheck,
  Database,
  FolderOpen,
  FolderSearch,
  HardDrive,
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
  emptyCategories,
  emptyFolderCategories,
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
  isNativeRuntime,
  nativeJobEvents,
  queryNativeIndex,
  searchNativeIndex,
  startNativeScan,
  type NativeIndexOverview,
  type NativeSearchResult,
} from "./nativeClient";
import { TreemapCanvas } from "./TreemapCanvas";
import "./styles.css";

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const nativeJobRef = useRef<{ jobId: number; eventOffset: number; indexPath: string } | null>(null);
  const [scan, setScan] = useState<ScanState>(initialScanState);
  const [filter, setFilter] = useState<CategoryKey | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NativeSearchResult[]>([]);
  const [currentIndexPath, setCurrentIndexPath] = useState<string | null>(null);
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  const [nativeRuntime, setNativeRuntime] = useState(false);
  const [runtimeMessage, setRuntimeMessage] = useState("Browser preview");

  useEffect(() => {
    void isNativeRuntime().then((native) => {
      setNativeRuntime(native);
      setRuntimeMessage(native ? "Native index mode" : "Browser preview");
    });
  }, []);

  const topFolders = useMemo(() => {
    return [...scan.folders].sort((a, b) => b.bytes - a.bytes).slice(0, 9);
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
      setRuntimeMessage("Native scan starting");
      setScan({
        ...initialScanState,
        status: "scanning",
        rootName: lastSegment(folder) || folder,
        startedAt: performance.now(),
        currentPath: folder,
      });

      const { jobId, indexPath } = await startNativeScan(folder);
      nativeJobRef.current = { jobId, eventOffset: 0, indexPath };
      setRuntimeMessage("Native index mode");
      void pollNativeJob(jobId);
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Native scan failed");
      setScan((current) => ({ ...current, status: "cancelled" }));
    }
  }

  async function pollNativeJob(jobId: number) {
    while (nativeJobRef.current?.jobId === jobId) {
      const offset = nativeJobRef.current.eventOffset;
      const events = await nativeJobEvents(jobId, offset);
      nativeJobRef.current.eventOffset += events.length;

      const latest = events.at(-1);
      if (latest) {
        if (latest.status === "Failed") {
          setRuntimeMessage(latest.message);
        }
        setScan((current) => ({
          ...current,
          status: latest.status === "Completed" ? "complete" : latest.status === "Cancelled" ? "cancelled" : "scanning",
          processedFiles: latest.files_scanned,
          totalFiles: Math.max(current.totalFiles, latest.files_scanned),
          processedBytes: latest.bytes_scanned,
          totalBytes: Math.max(current.totalBytes, latest.bytes_scanned),
          currentPath: latest.current_path ?? current.currentPath,
          elapsedMs: performance.now() - current.startedAt,
        }));
      }

      if (latest?.status === "Completed" || latest?.status === "Cancelled" || latest?.status === "Failed") {
        if (latest.status === "Completed" && nativeJobRef.current) {
          const overview = await queryNativeIndex(nativeJobRef.current.indexPath, 48);
          setScan((current) => mergeNativeOverview(current, overview));
          setCurrentIndexPath(nativeJobRef.current.indexPath);
          setRuntimeMessage("Native index ready");
        }
        nativeJobRef.current = null;
        return;
      }

      await wait(300);
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
          <HardDrive size={26} />
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
        <header className="topbar">
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

        <section className="scan-strip" aria-label="Scan progress">
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

        <section className="analysis-layout">
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

        <section className="folder-table">
          <div className="panel-header">
            <h2>Largest Folders</h2>
            <span><Search size={14} /> {formatCount(topFolders.length)} visible</span>
          </div>
          {topFolders.length === 0 ? (
            <div className="empty-state">Choose a folder to generate the first storage intelligence snapshot.</div>
          ) : (
            topFolders.map((folder) => (
              <div className="folder-row" key={folder.path}>
                <span>{folder.path}</span>
                <strong>{formatBytes(folder.bytes)}</strong>
                <small>{formatCount(folder.files)} files</small>
              </div>
            ))
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
            searchResults.map((file) => (
              <div className="folder-row file-row" key={file.path}>
                <span>{file.path}</span>
                <strong>{formatBytes(file.size)}</strong>
                <small>{file.extension ?? "(none)"}</small>
              </div>
            ))
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
              scan.largestFiles.slice(0, 10).map((file) => (
                <div className="folder-row file-row" key={file.path}>
                  <span>{file.path}</span>
                  <strong>{formatBytes(file.bytes)}</strong>
                  <small>{file.extension}</small>
                </div>
              ))
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
              scan.extensions.slice(0, 10).map((extension) => (
                <div className="folder-row extension-row" key={extension.extension}>
                  <span>.{extension.extension}</span>
                  <strong>{formatBytes(extension.bytes)}</strong>
                  <small>{formatCount(extension.files)} files</small>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="folder-table">
          <div className="panel-header">
            <h2>Duplicate Candidates</h2>
            <span><CopyCheck size={14} /> Stage 1 size groups</span>
          </div>
          {scan.duplicateCandidates.length === 0 ? (
            <div className="empty-state compact">Files with identical sizes will appear here as duplicate candidates.</div>
          ) : (
            scan.duplicateCandidates.slice(0, 12).map((candidate) => (
              <div className="duplicate-row" key={candidate.size}>
                <div>
                  <strong>{formatBytes(candidate.reclaimableBytes)} reclaimable</strong>
                  <span>{formatCount(candidate.files)} files at {formatBytes(candidate.size)} each</span>
                </div>
                <small>{candidate.samples.join(" | ")}</small>
              </div>
            ))
          )}
        </section>
      </section>
    </main>
  );
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
    size: group.size,
    files: group.file_count,
    reclaimableBytes: group.reclaimable_bytes,
    samples: [`confidence ${(group.confidence * 100).toFixed(0)}%`],
    confidence: "size-match" as const,
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

function Treemap({ folders, onSelect }: { folders: Array<FolderStats & { displayBytes: number }>; onSelect: (folder: FolderStats & { displayBytes: number }) => void }) {
  if (folders.length === 0) {
    return <div className="treemap-empty">No indexed folders yet</div>;
  }

  return <TreemapCanvas folders={folders} onSelect={onSelect} />;
}

function Recommendation({ text }: { text: string }) {
  return <button type="button">{text}</button>;
}

function postWorker(worker: Worker | null, message: ScanWorkerCommand) {
  worker?.postMessage(message);
}

function getProgress(scan: ScanState) {
  if (scan.totalFiles === 0) return 0;
  return Math.min(100, (scan.processedFiles / scan.totalFiles) * 100);
}

function makeDuplicateHint(scan: ScanState) {
  const reclaimable = scan.duplicateCandidates.reduce((sum, candidate) => sum + candidate.reclaimableBytes, 0);
  return reclaimable > 0 ? `${formatBytes(reclaimable)} possible duplicates found` : "Duplicate scan ready after indexing";
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

function makeCategoryHint(scan: ScanState, category: CategoryKey, label: string) {
  const bytes = scan.categories[category].bytes;
  return bytes > 0 ? `${formatBytes(bytes)} ${label} detected` : `${categories[category].label} analysis pending`;
}

createRoot(document.getElementById("root")!).render(<App />);
