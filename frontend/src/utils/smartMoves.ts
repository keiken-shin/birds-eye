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
