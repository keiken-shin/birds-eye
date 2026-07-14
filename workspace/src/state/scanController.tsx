import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScanStrategy } from "@bridge/domain";
import { useScanJob, type ScanJobView } from "../hooks/useScanJob";
import { useIndexData } from "./indexData";
import { useWorkspace } from "./workspaceStore";

export type QueuedScan = { root: string; strategy: ScanStrategy; intelligence?: boolean };

type ScanControllerValue = {
  view: ScanJobView;
  queue: QueuedScan[];
  start: (root: string, strategy: ScanStrategy, intelligence?: boolean) => Promise<void>;
  /** Run now if idle, otherwise append to the FIFO. Returns which happened.
   *  `intelligence` true/false applies the opt-in with the scan (enrichment
   *  runs in the same job); undefined leaves the index's setting untouched. */
  enqueue: (root: string, strategy: ScanStrategy, intelligence?: boolean) => "started" | "queued";
  dequeue: (index: number) => void;
  cancel: () => Promise<void>;
  reset: () => void;
};

const ScanControllerContext = createContext<ScanControllerValue | null>(null);

/**
 * Owns the scan job above the overlay so a scan keeps running (and completes) even when
 * the user closes the scan sheet and works in another lens — the mock's "runs in background".
 * Also holds a FIFO of pending scans so several roots can be lined up to run one after another.
 * ponytail: advances only on successful completion — a cancelled/failed scan halts the queue
 * (user clears or re-runs); add per-item retry/priorities/persistence only if asked.
 */
export function ScanControllerProvider({ children }: { children: ReactNode }) {
  const { refreshIndexes } = useIndexData();
  const { setIndexPath, setScopePath, select } = useWorkspace();
  const [queue, setQueue] = useState<QueuedScan[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const startRef = useRef<
    ((root: string, strategy: ScanStrategy, intelligence?: boolean) => Promise<void>) | null
  >(null);

  const onComplete = useCallback(
    (indexPath: string) => {
      setIndexPath(indexPath);
      setScopePath([]);
      select(null);
      void refreshIndexes();
      const [next, ...rest] = queueRef.current;
      if (next) {
        setQueue(rest);
        void startRef.current?.(next.root, next.strategy, next.intelligence);
      }
    },
    [refreshIndexes, setIndexPath, setScopePath, select]
  );

  const { view, start, cancel, reset } = useScanJob(onComplete);
  startRef.current = start;

  const enqueue = useCallback(
    (root: string, strategy: ScanStrategy, intelligence?: boolean): "started" | "queued" => {
      if (view.status === "scanning") {
        setQueue((q) => [...q, { root, strategy, intelligence }]);
        return "queued";
      }
      void start(root, strategy, intelligence);
      return "started";
    },
    [view.status, start]
  );

  const dequeue = useCallback((index: number) => {
    setQueue((q) => q.filter((_, i) => i !== index));
  }, []);

  const value = useMemo(
    () => ({ view, queue, start, enqueue, dequeue, cancel, reset }),
    [view, queue, start, enqueue, dequeue, cancel, reset]
  );
  return <ScanControllerContext.Provider value={value}>{children}</ScanControllerContext.Provider>;
}

export function useScanController() {
  const ctx = useContext(ScanControllerContext);
  if (!ctx) throw new Error("useScanController must be used within ScanControllerProvider");
  return ctx;
}
