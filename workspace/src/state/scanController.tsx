import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { ScanStrategy } from "@bridge/domain";
import { useScanJob, type ScanJobView } from "../hooks/useScanJob";
import { useIndexData } from "./indexData";
import { useWorkspace } from "./workspaceStore";

type ScanControllerValue = {
  view: ScanJobView;
  start: (root: string, strategy: ScanStrategy) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
};

const ScanControllerContext = createContext<ScanControllerValue | null>(null);

/**
 * Owns the scan job above the overlay so a scan keeps running (and completes) even when
 * the user closes the scan sheet and works in another lens — the mock's "runs in background".
 */
export function ScanControllerProvider({ children }: { children: ReactNode }) {
  const { refreshIndexes } = useIndexData();
  const { setIndexPath, setScopePath, select } = useWorkspace();

  const onComplete = useCallback(
    (indexPath: string) => {
      setIndexPath(indexPath);
      setScopePath([]);
      select(null);
      void refreshIndexes();
    },
    [refreshIndexes, setIndexPath, setScopePath, select]
  );

  const { view, start, cancel, reset } = useScanJob(onComplete);

  const value = useMemo(() => ({ view, start, cancel, reset }), [view, start, cancel, reset]);
  return <ScanControllerContext.Provider value={value}>{children}</ScanControllerContext.Provider>;
}

export function useScanController() {
  const ctx = useContext(ScanControllerContext);
  if (!ctx) throw new Error("useScanController must be used within ScanControllerProvider");
  return ctx;
}
