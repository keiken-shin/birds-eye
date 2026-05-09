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

export function lastSegment(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
