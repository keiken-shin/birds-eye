import { categories, formatBytes, type CategoryKey, type ScanState } from "../domain";

export function getProgress(scan: ScanState): number {
  if (scan.totalFiles === 0) return 0;
  return Math.min(100, (scan.processedFiles / scan.totalFiles) * 100);
}

export function makeDuplicateHint(scan: ScanState): string {
  const reclaimable = scan.duplicateCandidates.reduce((sum, candidate) => sum + candidate.reclaimableBytes, 0);
  return reclaimable > 0 ? `${formatBytes(reclaimable)} possible duplicates found` : "Duplicate scan ready after indexing";
}

export function makeCategoryHint(scan: ScanState, category: CategoryKey, label: string): string {
  const bytes = scan.categories[category].bytes;
  return bytes > 0 ? `${formatBytes(bytes)} ${label} detected` : `${categories[category].label} analysis pending`;
}

export function formatDate(epochSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(epochSeconds * 1000));
}
