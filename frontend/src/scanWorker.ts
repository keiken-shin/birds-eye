import {
  classifyFile,
  emptyCategories,
  emptyFolderCategories,
  getExtension,
  getFolderPath,
  getRelativePath,
  type DuplicateCandidate,
  type ExtensionStats,
  type FileStats,
  type FolderStats,
  type ScanProgressPayload,
  type ScanWorkerCommand,
  type ScanWorkerMessage,
} from "./domain";

let cancelled = false;
let paused = false;

self.onmessage = (event: MessageEvent<ScanWorkerCommand>) => {
  const command = event.data;

  if (command.type === "start") {
    void scanFiles(command.files).catch((error) => {
      postError(error instanceof Error ? error.message : "Browser scan failed");
    });
    return;
  }

  if (command.type === "pause") {
    paused = true;
    return;
  }

  if (command.type === "resume") {
    paused = false;
    return;
  }

  if (command.type === "cancel") {
    cancelled = true;
  }
};

async function scanFiles(files: File[]) {
  cancelled = false;
  paused = false;

  const rootName = getRelativePath(files[0]).split("/")[0] || "Selected Folder";
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const folderMap = new Map<string, FolderStats>();
  const extensionMap = new Map<string, ExtensionStats>();
  const sizeGroups = new Map<number, { files: number; samples: string[] }>();
  const categoryTotals = emptyCategories();
  const largestFiles: FileStats[] = [];
  const startedAt = performance.now();
  let processedFiles = 0;
  let processedBytes = 0;
  let currentPath = "-";

  for (let index = 0; index < files.length; index += 400) {
    if (cancelled) {
      post("cancelled", snapshot("cancelled"));
      return;
    }

    while (paused && !cancelled) {
      post("progress", snapshot("paused"));
      await wait(140);
    }

    const batch = files.slice(index, index + 400);

    for (const file of batch) {
      const relativePath = getRelativePath(file);
      const folderPath = getFolderPath(relativePath);
      const extension = getExtension(file.name);
      const category = classifyFile(file.name);
      const extensionStats = getOrCreateExtension(extensionMap, extension);
      const sizeGroup = getOrCreateSizeGroup(sizeGroups, file.size);

      for (const path of getFolderPathChain(folderPath)) {
        const folder = getOrCreateFolder(folderMap, path);
        folder.files += 1;
        folder.bytes += file.size;
        folder.categories[category] += file.size;
      }
      extensionStats.files += 1;
      extensionStats.bytes += file.size;
      sizeGroup.files += 1;
      if (sizeGroup.samples.length < 4) {
        sizeGroup.samples.push(relativePath);
      }
      categoryTotals[category].files += 1;
      categoryTotals[category].bytes += file.size;
      trackLargestFile(largestFiles, {
        path: relativePath,
        name: file.name,
        folder: folderPath,
        extension,
        bytes: file.size,
        category,
        modified: file.lastModified,
      });
      processedBytes += file.size;
      currentPath = folderPath;
    }

    processedFiles = Math.min(index + batch.length, files.length);
    post("progress", snapshot("scanning"));
    await wait(0);
  }

  processedFiles = files.length;
  post("finished", snapshot("complete"));

  function snapshot(status: ScanProgressPayload["status"]): ScanProgressPayload {
    return {
      status,
      rootName,
      totalFiles: files.length,
      processedFiles,
      totalBytes,
      processedBytes: Math.min(processedBytes, totalBytes),
      startedAt,
      elapsedMs: performance.now() - startedAt,
      currentPath,
      folders: Array.from(folderMap.values()),
      largestFiles: [...largestFiles],
      extensions: Array.from(extensionMap.values()).sort((a, b) => b.bytes - a.bytes).slice(0, 24),
      duplicateCandidates: getDuplicateCandidates(sizeGroups),
      duplicateOverlaps: [],
      categories: { ...categoryTotals },
    };
  }
}

function getFolderPathChain(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return ["Root"];
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function getOrCreateFolder(folderMap: Map<string, FolderStats>, path: string) {
  const existing = folderMap.get(path);
  if (existing) return existing;

  const created: FolderStats = {
    path,
    files: 0,
    bytes: 0,
    categories: emptyFolderCategories(),
  };
  folderMap.set(path, created);
  return created;
}

function getOrCreateExtension(extensionMap: Map<string, ExtensionStats>, extension: string) {
  const existing = extensionMap.get(extension);
  if (existing) return existing;

  const created = { extension, files: 0, bytes: 0 };
  extensionMap.set(extension, created);
  return created;
}

function trackLargestFile(largestFiles: FileStats[], file: FileStats) {
  largestFiles.push(file);
  largestFiles.sort((a, b) => b.bytes - a.bytes);
  if (largestFiles.length > 30) {
    largestFiles.length = 30;
  }
}

function getOrCreateSizeGroup(sizeGroups: Map<number, { files: number; samples: string[] }>, size: number) {
  const existing = sizeGroups.get(size);
  if (existing) return existing;

  const created = { files: 0, samples: [] };
  sizeGroups.set(size, created);
  return created;
}

function getDuplicateCandidates(sizeGroups: Map<number, { files: number; samples: string[] }>): DuplicateCandidate[] {
  return Array.from(sizeGroups.entries())
    .filter(([size, group]) => size > 0 && group.files > 1)
    .map(([size, group]) => ({
      size,
      files: group.files,
      reclaimableBytes: size * (group.files - 1),
      samples: group.samples,
      confidence: "size-match" as const,
    }))
    .sort((a, b) => b.reclaimableBytes - a.reclaimableBytes)
    .slice(0, 20);
}

function post(type: Exclude<ScanWorkerMessage["type"], "error">, payload: ScanProgressPayload) {
  self.postMessage({ type, payload } satisfies ScanWorkerMessage);
}

function postError(message: string, path?: string) {
  self.postMessage({ type: "error", message, path } satisfies ScanWorkerMessage);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
