import type { NativeDuplicateFile } from "@bridge/nativeClient";

/** Paths that look like copies rather than originals — deprioritized as the keeper. */
const SUGGEST_SUSPECT = /\b(backup|old|archive|copy|temp|202\d)\b/i;

/**
 * Which copy of a duplicate group to keep: not in a backup-ish path, most recently
 * modified, shallowest. (Ported from the feat/intelligence frontend.)
 */
export function suggestKeep(files: NativeDuplicateFile[]): string {
  if (files.length === 0) return "";
  return [...files].sort((a, b) => {
    const aSuspect = SUGGEST_SUSPECT.test(a.path) ? 1 : 0;
    const bSuspect = SUGGEST_SUSPECT.test(b.path) ? 1 : 0;
    if (aSuspect !== bSuspect) return aSuspect - bSuspect;
    const aTime = a.modified_at ?? 0;
    const bTime = b.modified_at ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length;
  })[0].path;
}

export type MoveSuggestion = {
  targetFolder: string;
  stagePaths: string[];
  reason: string;
};

/**
 * One consolidation suggestion per group: most copies live in one folder → keep that
 * folder's copy, stage the strays. (Ported from the feat/intelligence frontend.)
 */
export function computeSmartMoves(files: NativeDuplicateFile[]): MoveSuggestion[] {
  if (files.length === 0) return [];

  const folderMap = new Map<string, NativeDuplicateFile[]>();
  for (const file of files) {
    const folder = file.path.replace(/[\\/][^\\/]+$/, "");
    const arr = folderMap.get(folder) ?? [];
    arr.push(file);
    folderMap.set(folder, arr);
  }
  if (folderMap.size <= 1) return [];

  const ranked = [...folderMap.entries()].sort(([folderA, filesA], [folderB, filesB]) => {
    if (filesB.length !== filesA.length) return filesB.length - filesA.length;
    const maxModA = Math.max(...filesA.map((f) => f.modified_at ?? 0));
    const maxModB = Math.max(...filesB.map((f) => f.modified_at ?? 0));
    if (maxModB !== maxModA) return maxModB - maxModA;
    return folderA.split(/[\\/]/).length - folderB.split(/[\\/]/).length;
  });

  const [targetFolder, dominant] = ranked[0];
  const stagePaths = ranked.slice(1).flatMap(([, fs]) => fs.map((f) => f.path));
  if (!stagePaths.length) return [];

  return [
    {
      targetFolder,
      stagePaths,
      reason: `${dominant.length} of ${files.length} copies live here — stage the strays`,
    },
  ];
}
