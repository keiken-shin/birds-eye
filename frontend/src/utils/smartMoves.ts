import type { NativeDuplicateFile } from "../nativeClient";

export type MoveGroup = {
  targetFolder: string;
  filesToMove: string[];
  reason: string;
};

export function computeSmartMoves(files: NativeDuplicateFile[]): MoveGroup[] {
  if (files.length === 0) return [];

  const folderMap = new Map<string, NativeDuplicateFile[]>();
  for (const file of files) {
    const folder = file.path.replace(/[\\/][^\\/]+$/, "");
    const arr = folderMap.get(folder) ?? [];
    arr.push(file);
    folderMap.set(folder, arr);
  }

  if (folderMap.size <= 1) return [];

  const ranked = Array.from(folderMap.entries()).sort(
    ([folderA, filesA], [folderB, filesB]) => {
      if (filesB.length !== filesA.length) return filesB.length - filesA.length;
      const maxModA = Math.max(...filesA.map((f) => f.modified_at ?? 0));
      const maxModB = Math.max(...filesB.map((f) => f.modified_at ?? 0));
      if (maxModB !== maxModA) return maxModB - maxModA;
      return folderA.split(/[\\/]/).length - folderB.split(/[\\/]/).length;
    }
  );

  const [targetFolder, dominantFiles] = ranked[0];
  const filesToMove = ranked.slice(1).flatMap(([, fs]) => fs.map((f) => f.path));

  if (filesToMove.length < 2) return [];

  return [
    {
      targetFolder,
      filesToMove,
      reason: `${dominantFiles.length} of ${files.length} copies live here — consolidate the rest`,
    },
  ];
}

export interface FolderMove {
  keepFolder: string;
  stageFolder: string;
  fileCount: number;
  reclaimableBytes: number;
  files: NativeDuplicateFile[];
}

export function groupByParentFolder(files: NativeDuplicateFile[]): FolderMove[] {
  if (files.length === 0) return [];

  const byFolder = new Map<string, NativeDuplicateFile[]>();
  for (const file of files) {
    const folder = file.path.replace(/[\\/][^\\/]+$/, "");
    const arr = byFolder.get(folder) ?? [];
    arr.push(file);
    byFolder.set(folder, arr);
  }

  if (byFolder.size < 2) return [];

  // Build a map from basename -> list of (folder, file) pairs
  const byBasename = new Map<string, Array<{ folder: string; file: NativeDuplicateFile }>>();
  for (const [folder, folderFiles] of byFolder) {
    for (const file of folderFiles) {
      const basename = file.path.replace(/^.*[\\/]/, "");
      const arr = byBasename.get(basename) ?? [];
      arr.push({ folder, file });
      byBasename.set(basename, arr);
    }
  }

  // Only pair folders that share at least one common basename (i.e., duplicate files)
  const sharedPairs = new Map<string, { folderA: string; folderB: string; files: NativeDuplicateFile[] }>();
  for (const [, entries] of byBasename) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const folderA = entries[i].folder;
        const folderB = entries[j].folder;
        const key = folderA < folderB ? `${folderA}|||${folderB}` : `${folderB}|||${folderA}`;
        const existing = sharedPairs.get(key);
        if (existing) {
          existing.files.push(entries[i].file, entries[j].file);
        } else {
          sharedPairs.set(key, {
            folderA: folderA < folderB ? folderA : folderB,
            folderB: folderA < folderB ? folderB : folderA,
            files: [entries[i].file, entries[j].file],
          });
        }
      }
    }
  }

  if (sharedPairs.size === 0) return [];

  const results: FolderMove[] = [];

  for (const { folderA, folderB, files: pairFiles } of sharedPairs.values()) {
    const filesA = pairFiles.filter((f) => f.path.replace(/[\\/][^\\/]+$/, "") === folderA);
    const filesB = pairFiles.filter((f) => f.path.replace(/[\\/][^\\/]+$/, "") === folderB);

    if (filesA.length === 0 || filesB.length === 0) continue;

    const keepPath = suggestKeep(pairFiles);
    const keepFolder = keepPath.replace(/[\\/][^\\/]+$/, "");
    const stageFolder = keepFolder === folderA ? folderB : folderA;
    const stageFiles = keepFolder === folderA ? filesB : filesA;

    results.push({
      keepFolder,
      stageFolder,
      fileCount: stageFiles.length,
      reclaimableBytes: stageFiles.reduce((sum, f) => sum + f.size, 0),
      files: stageFiles,
    });
  }

  return results;
}

const SUGGEST_SUSPECT = /\b(backup|old|archive|copy|temp|202\d)\b/i;

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
