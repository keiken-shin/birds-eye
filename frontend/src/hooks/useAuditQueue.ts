import { useCallback, useMemo, useState } from "react";
import { trashFiles } from "../nativeClient";
import type { NativeDuplicateFile } from "../nativeClient";

export function useAuditQueue(
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>
): {
  staged: Map<string, NativeDuplicateFile>;
  stagedBytes: number;
  stage: (file: NativeDuplicateFile) => void;
  unstage: (path: string) => void;
  trashStaged: () => Promise<void>;
  clearQueue: () => void;
} {
  const [staged, setStaged] = useState<Map<string, NativeDuplicateFile>>(new Map());

  const stagedBytes = useMemo(
    () => Array.from(staged.values()).reduce((sum, f) => sum + f.size, 0),
    [staged]
  );

  const stage = useCallback((file: NativeDuplicateFile) => {
    setStaged((prev) => new Map(prev).set(file.path, file));
  }, []);

  const unstage = useCallback((path: string) => {
    setStaged((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }, []);

  const trashStaged = useCallback(async () => {
    const paths = Array.from(staged.keys());
    if (paths.length === 0) return;
    const result = await trashFiles(paths);
    const failedSet = new Set(result.failed.map((f) => f.path));
    setStaged((prev) => {
      const next = new Map(prev);
      for (const path of paths) {
        if (!failedSet.has(path)) next.delete(path);
      }
      return next;
    });
    if (result.failed.length > 0) {
      const reasons = result.failed.map((f) => `${f.path}: ${f.reason}`).join("; ");
      setRuntimeMessage(`Failed to trash ${result.failed.length} file(s): ${reasons}`);
    }
  }, [staged, setRuntimeMessage]);

  const clearQueue = useCallback(() => {
    setStaged(new Map());
  }, []);

  return { staged, stagedBytes, stage, unstage, trashStaged, clearQueue };
}
