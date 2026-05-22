import { useCallback, useState } from "react";
import { queryNativeDuplicateFiles, type NativeDuplicateFile } from "../nativeClient";
import type { ScanState } from "../domain";

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
  comparisonCursor: number;
  setComparisonCursor: (n: number) => void;
  selectDuplicateCandidate: (candidate: DuplicateCandidate) => Promise<void>;
  clearDuplicates: () => void;
} {
  const [duplicateFiles, setDuplicateFiles] = useState<NativeDuplicateFile[]>([]);
  const [selectedDuplicateGroup, setSelectedDuplicateGroup] = useState<number | null>(null);
  const [comparisonCursor, setComparisonCursor] = useState(0);

  const selectDuplicateCandidate = useCallback(async (candidate: DuplicateCandidate) => {
    setSelectedDuplicateGroup(candidate.id ?? null);
    setDuplicateFiles([]);
    setComparisonCursor(0);
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
    setComparisonCursor(0);
  }, []);

  return {
    duplicateFiles,
    selectedDuplicateGroup,
    comparisonCursor,
    setComparisonCursor,
    selectDuplicateCandidate,
    clearDuplicates,
  };
}
