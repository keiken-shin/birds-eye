export type CategoryKey =
  | "photos"
  | "videos"
  | "music"
  | "documents"
  | "archives"
  | "code"
  | "installers"
  | "models"
  | "other";

export type Category = {
  label: string;
  color: string;
  extensions: string[];
};

export type FolderStats = {
  path: string;
  files: number;
  bytes: number;
  categories: Record<CategoryKey, number>;
};

export type FileStats = {
  path: string;
  name: string;
  folder: string;
  extension: string;
  bytes: number;
  category: CategoryKey;
  modified: number;
};

export type ExtensionStats = {
  extension: string;
  files: number;
  bytes: number;
};

export type DuplicateCandidate = {
  id?: number;
  size: number;
  files: number;
  reclaimableBytes: number;
  samples: string[];
  confidence: "size-match";
};

export type ScanStatus = "idle" | "scanning" | "paused" | "complete" | "cancelled";

export type ScanState = {
  status: ScanStatus;
  finalizing: boolean;
  progressCurrent: number;
  progressTotal: number;
  progressLabel: string;
  rootName: string;
  totalFiles: number;
  processedFiles: number;
  totalBytes: number;
  processedBytes: number;
  startedAt: number;
  elapsedMs: number;
  currentPath: string;
  folders: FolderStats[];
  largestFiles: FileStats[];
  extensions: ExtensionStats[];
  duplicateCandidates: DuplicateCandidate[];
  categories: Record<CategoryKey, { files: number; bytes: number }>;
};

export type ScanProgressPayload = Omit<ScanState, "status"> & {
  status: Extract<ScanStatus, "scanning" | "paused" | "complete" | "cancelled">;
};

export type ScanWorkerCommand =
  | { type: "start"; files: File[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" };

export type ScanWorkerMessage =
  | { type: "progress"; payload: ScanProgressPayload }
  | { type: "finished"; payload: ScanProgressPayload }
  | { type: "cancelled"; payload: ScanProgressPayload };

export const categories: Record<CategoryKey, Category> = {
  photos: {
    label: "Photos",
    color: "#f472b6",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "heic", "raw", "cr2", "nef", "arw"],
  },
  videos: {
    label: "Videos",
    color: "#c084fc",
    extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts"],
  },
  music: {
    label: "Music",
    color: "#4ade80",
    extensions: ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma"],
  },
  documents: {
    label: "Documents",
    color: "#60a5fa",
    extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "epub"],
  },
  archives: {
    label: "Archives",
    color: "#fbbf24",
    extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
  },
  code: {
    label: "Code",
    color: "#22d3ee",
    extensions: ["js", "ts", "tsx", "jsx", "rs", "py", "go", "java", "cs", "cpp", "c", "html", "css", "json"],
  },
  installers: {
    label: "Installers",
    color: "#fb7185",
    extensions: ["exe", "msi", "dmg", "pkg", "deb", "rpm", "appimage"],
  },
  models: {
    label: "AI Models",
    color: "#a3e635",
    extensions: ["safetensors", "ckpt", "pt", "pth", "onnx", "gguf", "bin"],
  },
  other: {
    label: "Other",
    color: "#94a3b8",
    extensions: [],
  },
};

export const emptyCategories = (): ScanState["categories"] =>
  Object.keys(categories).reduce((acc, key) => {
    acc[key as CategoryKey] = { files: 0, bytes: 0 };
    return acc;
  }, {} as ScanState["categories"]);

export const emptyFolderCategories = (): Record<CategoryKey, number> =>
  Object.keys(categories).reduce((acc, key) => {
    acc[key as CategoryKey] = 0;
    return acc;
  }, {} as Record<CategoryKey, number>);

export const initialScanState: ScanState = {
  status: "idle",
  finalizing: false,
  progressCurrent: 0,
  progressTotal: 0,
  progressLabel: "",
  rootName: "No folder selected",
  totalFiles: 0,
  processedFiles: 0,
  totalBytes: 0,
  processedBytes: 0,
  startedAt: 0,
  elapsedMs: 0,
  currentPath: "-",
  folders: [],
  largestFiles: [],
  extensions: [],
  duplicateCandidates: [],
  categories: emptyCategories(),
};

export function classifyFile(name: string): CategoryKey {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const match = (Object.keys(categories) as CategoryKey[]).find((key) => categories[key].extensions.includes(extension));
  return match ?? "other";
}

export function getRelativePath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

export function getFolderPath(path: string) {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "Root";
}

export function getExtension(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return extension && extension !== name.toLowerCase() ? extension : "(none)";
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

/**
 * Unix-seconds floor below which a file's modified time is treated as lost, not
 * real (1990-01-01 UTC). Transfers that strip timestamps — some phone/MTP
 * copies, messaging exports, cloud downloads — reset mtime to the 1980 FAT
 * epoch, which would otherwise make a recent file look decades old and "stale".
 */
export const MIN_REAL_MTIME = 631_152_000;

/**
 * Whole days since a file's modified time, or null when the timestamp is
 * missing or implausibly old (a reset/lost mtime we refuse to trust for age or
 * staleness). Callers render null as "unknown" rather than a huge number.
 */
export function ageDays(
  modifiedAtSec: number | null,
  nowSec: number = Math.floor(Date.now() / 1000)
): number | null {
  if (modifiedAtSec === null || modifiedAtSec < MIN_REAL_MTIME) return null;
  return Math.max(0, Math.floor((nowSec - modifiedAtSec) / 86_400));
}

/**
 * A file age in days, rendered for humans: days under a year, otherwise years
 * plus the remaining days ("46y 206d ago" beats "16,996d ago"). Returns the
 * full phrase including "ago" so callers don't produce "today ago".
 */
export function formatAge(days: number): string {
  if (days <= 0) return "today";
  if (days < 365) return `${formatCount(days)}d ago`;
  const years = Math.floor(days / 365);
  const rem = days % 365;
  return rem > 0 ? `${years}y ${rem}d ago` : `${years}y ago`;
}

export function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export type SearchFilters = {
  kinds?: CategoryKey[];
  extensions?: string[];
  minBytes?: number;
  maxBytes?: number;
  useRegex?: boolean;
};

export type QueueItemStatus = "scanning" | "finalizing" | "done" | "loaded";

export type ScanStrategy = "smart" | "metadata";

export const defaultScanStrategy: ScanStrategy = "smart";

export function parseScanStrategy(value: unknown): ScanStrategy {
  if (value === "smart" || value === "metadata") return value;
  return defaultScanStrategy;
}

export type ScanLogEntry = {
  ts: number;
  level: "info" | "warn" | "error";
  message: string;
  phase?: string;
  isTimingMatrix?: boolean;
};

type PhaseTimingEntry = { phase: string; duration_ms: number };

export function formatTimingMatrix(timings: PhaseTimingEntry[]): string {
  const total = timings.reduce((sum, t) => sum + t.duration_ms, 0);
  const lines = timings.map((t) => {
    const secs = (t.duration_ms / 1000).toFixed(1);
    return `  ${t.phase.padEnd(22)}${secs}s`;
  });
  const totalSecs = (total / 1000).toFixed(1);
  lines.push(`  ${"─".repeat(22)}─────`);
  lines.push(`  ${"total".padEnd(22)}${totalSecs}s`);
  return ["── Time Breakdown " + "─".repeat(22), ...lines].join("\n");
}

export type QueueItem = {
  id: string;
  rootName: string;
  status: QueueItemStatus;
  progress: number;
  progressCurrent?: number;
  progressTotal?: number;
  progressLabel?: string;
  indexPath: string;
  totalFiles?: number;
  totalBytes?: number;
  foldersScanned?: number;
  elapsedMs?: number;
  loadedAt?: number;
  logs: ScanLogEntry[];
};
