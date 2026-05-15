import { useCallback, useEffect, useState } from "react";
import { listNativeIndexes, NativeIndexEntry } from "../nativeClient";

export function useSavedIndexes({
  nativeRuntime,
  setRuntimeMessage,
}: {
  nativeRuntime: boolean;
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
}): {
  savedIndexes: NativeIndexEntry[];
  refreshSavedIndexes: () => Promise<void>;
} {
  const [savedIndexes, setSavedIndexes] = useState<NativeIndexEntry[]>([]);

  const refreshSavedIndexes = useCallback(async () => {
    try {
      setSavedIndexes(await listNativeIndexes());
    } catch (error) {
      setRuntimeMessage(
        error instanceof Error ? error.message : "Failed to list indexes",
      );
    }
  }, [setRuntimeMessage]);

  useEffect(() => {
    if (nativeRuntime) {
      void refreshSavedIndexes();
    }
  }, [nativeRuntime, refreshSavedIndexes]);

  return { savedIndexes, refreshSavedIndexes };
}
