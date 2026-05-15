import {
  categories,
  emptyCategories,
  emptyFolderCategories,
  lastSegment,
  type CategoryKey,
  type ScanState,
} from "../domain";
import type { NativeIndexOverview, NativeJobEvent } from "../nativeClient";

export function nativeJobEventFingerprint(event: NativeJobEvent): string {
  return [
    event.job_id,
    event.status,
    event.files_scanned,
    event.bytes_scanned,
    event.current_path ?? "",
    event.message ?? "",
  ].join("|");
}

export function mergeNativeOverview(scan: ScanState, overview: NativeIndexOverview): ScanState {
  const folderCategoryMap = new Map<string, ReturnType<typeof emptyFolderCategories>>();
  for (const media of overview.folder_media) {
    const cats = folderCategoryMap.get(media.folder_path) ?? emptyFolderCategories();
    cats[categoryFromMediaKind(media.media_kind)] += media.total_bytes;
    folderCategoryMap.set(media.folder_path, cats);
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

export function categoryFromMediaKind(kind: string): CategoryKey {
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

export function mediaKindFromCategory(category: CategoryKey): string {
  if (category === "photos") return "photo";
  if (category === "videos") return "video";
  if (category === "archives") return "archive";
  if (category === "documents") return "document";
  if (category === "installers") return "installer";
  if (category === "models") return "model";
  return category === "other" ? "other" : category;
}
