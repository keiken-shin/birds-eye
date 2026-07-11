import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelNativeScan,
  listenNativeJobEvents,
  nativeJobEvents,
  startNativeScan,
  type NativeJobEvent,
  type NativeJobStatus,
} from "@bridge/nativeClient";
import type { ScanStrategy } from "@bridge/domain";

export type ScanLine = { n: number; phase: string; message: string };
export type ScanJobView = {
  jobId: number | null;
  indexPath: string | null;
  status: "idle" | "scanning" | "complete" | "cancelled" | "failed";
  message: string;
  pct: number; // -1 = indeterminate
  files: number;
  folders: number;
  bytes: number;
  currentPath: string;
  lines: ScanLine[];
};

const IDLE: ScanJobView = {
  jobId: null,
  indexPath: null,
  status: "idle",
  message: "",
  pct: -1,
  files: 0,
  folders: 0,
  bytes: 0,
  currentPath: "",
  lines: [],
};

const TERMINAL: Record<NativeJobStatus, ScanJobView["status"] | null> = {
  Completed: "complete",
  Cancelled: "cancelled",
  Failed: "failed",
  Running: null,
};

export function useScanJob(onComplete?: (indexPath: string) => void) {
  const [view, setView] = useState<ScanJobView>(IDLE);
  const jobRef = useRef<{ jobId: number; indexPath: string } | null>(null);
  const lineCount = useRef(0);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const apply = useCallback((event: NativeJobEvent) => {
    const job = jobRef.current;
    if (!job || event.job_id !== job.jobId) return;

    if (event.log_line) {
      setView((v) => ({
        ...v,
        lines: [...v.lines, { n: ++lineCount.current, phase: event.log_line!.phase, message: event.log_line!.message }].slice(-200),
      }));
      return;
    }

    const terminal = TERMINAL[event.status];
    setView((v) => ({
      ...v,
      status: terminal ?? "scanning",
      message: event.message || v.message,
      pct: event.progress_total > 0 ? Math.min(100, (event.progress_current / event.progress_total) * 100) : v.pct,
      files: Math.max(v.files, event.files_scanned),
      folders: Math.max(v.folders, event.folders_scanned),
      bytes: Math.max(v.bytes, event.bytes_scanned),
      currentPath: event.current_path ?? v.currentPath,
    }));

    if (event.status === "Completed") {
      setView((v) => ({ ...v, pct: 100 }));
      onCompleteRef.current?.(job.indexPath);
    }
  }, []);

  // Live event channel for the active job.
  useEffect(() => {
    if (view.jobId === null) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenNativeJobEvents(apply).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    // Backfill any events emitted before the listener attached.
    void nativeJobEvents(view.jobId, 0)
      .then((events) => events.forEach(apply))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [view.jobId, apply]);

  const start = useCallback(async (root: string, strategy: ScanStrategy) => {
    lineCount.current = 0;
    try {
      const { jobId, indexPath } = await startNativeScan(root, strategy);
      jobRef.current = { jobId, indexPath };
      setView({ ...IDLE, jobId, indexPath, status: "scanning", message: "Scanning…" });
    } catch (e) {
      // A rejected start must be visible, not an unhandled rejection in the console.
      jobRef.current = null;
      setView({ ...IDLE, status: "failed", message: `Couldn't start the scan: ${String(e)}` });
    }
  }, []);

  const cancel = useCallback(async () => {
    if (jobRef.current) await cancelNativeScan(jobRef.current.jobId).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    jobRef.current = null;
    setView(IDLE);
  }, []);

  return { view, start, cancel, reset };
}
