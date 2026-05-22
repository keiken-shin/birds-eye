import { useCallback, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { trashFiles } from "../nativeClient";
import type { NativeDuplicateFile } from "../nativeClient";

export interface TrashProgress {
  status: "idle" | "running" | "done";
  total: number;
  completed: number;
  failedCount: number;
  bytesCleared: number;
  log: string[];
}

const INITIAL_PROGRESS: TrashProgress = {
  status: "idle",
  total: 0,
  completed: 0,
  failedCount: 0,
  bytesCleared: 0,
  log: [],
};

export function useAuditQueue(
  setRuntimeMessage: Dispatch<SetStateAction<string>>
): {
  staged: Map<string, NativeDuplicateFile>;
  stagedBytes: number;
  stage: (file: NativeDuplicateFile) => void;
  unstage: (path: string) => void;
  trashStaged: () => Promise<void>;
  clearQueue: () => void;
  trashProgress: TrashProgress;
  dismissProgress: () => void;
} {
  const [staged, setStaged] = useState<Map<string, NativeDuplicateFile>>(new Map());
  const [trashProgress, setTrashProgress] = useState<TrashProgress>(INITIAL_PROGRESS);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

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
    const entries = Array.from(stagedRef.current.entries());
    if (entries.length === 0) return;

    setTrashProgress({
      status: "running",
      total: entries.length,
      completed: 0,
      failedCount: 0,
      bytesCleared: 0,
      log: [],
    });

    const failed: Array<{ path: string; reason: string }> = [];

    try {
      const result = await trashFiles(entries.map(([path]) => path));
      failed.push(...result.failed);
    } catch {
      failed.push(...entries.map(([path]) => ({ path, reason: "Trash operation failed" })));
    }

    const failedPaths = new Set(failed.map((failure) => failure.path));
    const successfulEntries = entries.filter(([path]) => !failedPaths.has(path));

    if (successfulEntries.length > 0) {
      setStaged((prev) => {
        const next = new Map(prev);
        for (const [path] of successfulEntries) next.delete(path);
        return next;
      });
    }

    setTrashProgress({
      status: "done",
      total: entries.length,
      completed: entries.length,
      failedCount: failed.length,
      bytesCleared: successfulEntries.reduce((sum, [, file]) => sum + file.size, 0),
      log: successfulEntries.map(([path]) => path).reverse().slice(0, 20),
    });

    if (failed.length > 0) {
      const reasons = failed.map((f) => `${f.path}: ${f.reason}`).join("; ");
      setRuntimeMessage(`Failed to trash ${failed.length} file(s): ${reasons}`);
    }
  }, [setRuntimeMessage]);

  const clearQueue = useCallback(() => {
    setStaged(new Map());
  }, []);

  const dismissProgress = useCallback(() => setTrashProgress(INITIAL_PROGRESS), []);

  return {
    staged,
    stagedBytes,
    stage,
    unstage,
    trashStaged,
    clearQueue,
    trashProgress,
    dismissProgress,
  };
}
