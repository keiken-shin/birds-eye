import { useCallback, useState } from "react";
import { queryNativeDuplicateFiles, NativeDuplicateFile } from "../nativeClient";
import { ScanState } from "../domain";

type DuplicateCandidate = ScanState["duplicateCandidates"][number];

export function useDuplicates({
  currentIndexPath,
  setRuntimeMessage,
}: {
  currentIndexPath: string | null;
  setRuntimeMessage: React.Dispatch<React.SetStateAction<string>>;
}): {
  duplicateFiles: NativeDuplicateFile[];
  selectedDuplicateGroup: number | null;
  selectDuplicateCandidate: (candidate: DuplicateCandidate) => Promise<void>;
  clearDuplicates: () => void;
} {
  const [duplicateFiles, setDuplicateFiles] = useState<NativeDuplicateFile[]>([]);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<number | null>(null);

  const selectDuplicateCandidate = useCallback(async (candidate: DuplicateCandidate) => {
    setSelectedDuplicateGroup(candidate.id ?? null);
    setDuplicateFiles([]);
    if (!candidate.id || !currentIndexPath) return;
    try {
      const files = await queryNativeDuplicateFiles(currentIndexPath, candidate.id, 24);
      setDuplicateFiles(files);
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Duplicate details failed");
    }
  }, [currentIndexPath, setRuntimeMessage]);

  const clearDuplicates = useCallback(() => {
    setDuplicateFiles([]);
    setSelectedDuplicateGroup(null);
  }, []);

  return { duplicateFiles, selectedDuplicateGroup, selectDuplicateCandidate, clearDuplicates };
}
