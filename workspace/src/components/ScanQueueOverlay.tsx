import { useState } from "react";
import { deleteNativeIndex, type NativeIndexEntry } from "@bridge/nativeClient";
import { formatBytes, formatCount, lastSegment } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";

export function ScanQueueOverlay() {
  const { overlay, setOverlay, setIndexPath } = useWorkspace();
  const { indexes, activeEntry, refreshIndexes } = useIndexData();
  const { enqueue, queue, dequeue, view } = useScanController();

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rescanningId, setRescanningId] = useState<string | null>(null);

  const close = () => setOverlay(null);

  const handleOpen = (entry: NativeIndexEntry) => {
    setIndexPath(entry.index_path);
    setOverlay(null);
  };

  const handleRescan = (entry: NativeIndexEntry) => {
    if (!entry.root_path) return;
    setRescanningId(entry.index_path);
    setError(null);
    try {
      // Runs now if idle, else lines up behind the running scan. Only follow it to the
      // progress sheet when it actually started.
      if (enqueue(entry.root_path, entry.scan_strategy) === "started") setOverlay("scan");
    } catch (e) {
      setError(String(e));
    } finally {
      setRescanningId(null);
    }
  };

  const handleDeleteClick = async (entry: NativeIndexEntry) => {
    if (confirmDeleteId !== entry.index_path) {
      // First click: arm confirm
      setConfirmDeleteId(entry.index_path);
      setError(null);
      return;
    }
    // Second click: execute delete
    setDeletingId(entry.index_path);
    setError(null);
    try {
      await deleteNativeIndex(entry.index_path);
      setConfirmDeleteId(null);
      await refreshIndexes();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingId(null);
    }
  };

  if (overlay !== "queue") return null;

  const isActive = (entry: NativeIndexEntry) =>
    activeEntry !== null && activeEntry.index_path === entry.index_path;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,.66)] backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className="be-in flex max-h-[660px] w-[620px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-line px-4.5 py-4" style={{ paddingInline: 18 }}>
          <span className="text-[15px] font-semibold">Scans</span>
          <span className="mono text-11 text-dim">
            {indexes.length} {indexes.length === 1 ? "indexed root" : "indexed roots"}
          </span>
          <button type="button" onClick={close} className="ml-auto text-[16px] text-dim hover:text-ink">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4.5 py-3.5" style={{ paddingInline: 18 }}>
          {error && (
            <div className="mb-3 rounded-[7px] border border-danger/30 bg-danger/[0.08] px-3 py-2 text-12 text-danger">
              {error}
            </div>
          )}
          {view.status === "scanning" && (
            <div className="mb-3.5">
              <div className="mb-1.5 text-10 tracking-[0.14em] text-label">▶ RUNNING</div>
              <div className="flex items-center gap-2.5 rounded-[7px] border border-primary/30 bg-primary/[0.05] px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-12" title={view.message}>
                  {view.message || "Scanning…"}
                </span>
                {view.pct >= 0 && <span className="mono flex-none text-11 text-primary-ink">{Math.round(view.pct)}%</span>}
                <button
                  type="button"
                  onClick={() => setOverlay("scan")}
                  className="flex-none rounded-[6px] border border-primary/40 px-2.5 py-1 text-11 font-semibold text-primary-ink"
                >
                  View progress
                </button>
              </div>
            </div>
          )}
          {view.status === "failed" && view.message && (
            <div className="mb-3 rounded-[7px] border border-danger/30 bg-danger/[0.08] px-3 py-2 text-12 text-danger">
              {view.message}
            </div>
          )}
          {queue.length > 0 && (
            <div className="mb-3.5">
              <div className="mb-1.5 text-10 tracking-[0.14em] text-label">
                ◷ QUEUED · runs after the active scan
              </div>
              <div className="flex flex-col gap-1.5">
                {queue.map((q, i) => (
                  <div
                    key={`${q.root}:${i}`}
                    className="flex items-center gap-2 rounded-[7px] border border-line-modal bg-window px-3 py-1.5"
                  >
                    <span className="mono text-11 text-dim">{i + 1}</span>
                    <span className="truncate text-12" title={q.root}>
                      {lastSegment(q.root)}
                    </span>
                    <span className="text-faint text-10">{q.strategy}</span>
                    <button
                      type="button"
                      onClick={() => dequeue(i)}
                      className="ml-auto rounded-[5px] border border-line-modal px-2 py-0.5 text-11 text-dim hover:text-danger"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {indexes.length === 0 ? (
            <div className="py-6 text-12 italic text-label">
              No scans yet. Press ⌘N to scan a folder.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {indexes.map((entry) => {
                const active = isActive(entry);
                const isDeleting = deletingId === entry.index_path;
                const isRescanning = rescanningId === entry.index_path;
                const confirmingDelete = confirmDeleteId === entry.index_path;
                const rootName = entry.root_path ? lastSegment(entry.root_path) : "(unknown root)";
                const scannedDate = entry.last_scanned_at
                  ? new Date(entry.last_scanned_at * 1000).toLocaleDateString()
                  : "—";

                return (
                  <div
                    key={entry.index_path}
                    className={[
                      "rounded-[9px] border px-3 py-2.5",
                      active
                        ? "border-primary/40 bg-primary/[0.05]"
                        : "border-line-modal bg-window",
                    ].join(" ")}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-13 font-medium" title={rootName}>
                            {rootName}
                          </span>
                          {active && (
                            <span className="flex-none rounded-[4px] bg-primary/[0.18] px-1.5 py-px text-[10px] text-primary-ink">
                              active
                            </span>
                          )}
                        </div>
                        {entry.root_path && (
                          <div
                            className="mono mt-0.5 truncate text-[10.5px] text-dim"
                            title={entry.root_path}
                          >
                            {entry.root_path}
                          </div>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-10 text-muted">
                          <span className="mono">{formatCount(entry.files_scanned)} files</span>
                          <span className="text-label">·</span>
                          <span className="mono">{formatBytes(entry.bytes_scanned)}</span>
                          <span className="text-label">·</span>
                          <span className="text-faint">{entry.scan_strategy}</span>
                          <span className="text-label">·</span>
                          <span>{scannedDate}</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-none items-center gap-1.5 pt-0.5">
                        <button
                          type="button"
                          onClick={() => handleOpen(entry)}
                          className="rounded-[6px] border border-line-modal px-2.5 py-1 text-11 text-ink-soft hover:text-ink"
                        >
                          Open
                        </button>
                        {entry.root_path && (
                          <button
                            type="button"
                            disabled={isRescanning || rescanningId !== null}
                            onClick={() => handleRescan(entry)}
                            className="rounded-[6px] border border-line-modal px-2.5 py-1 text-11 text-ink-soft hover:text-ink disabled:opacity-50"
                          >
                            {isRescanning ? "Starting…" : "Re-scan"}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={isDeleting}
                          onClick={() => void handleDeleteClick(entry)}
                          className={[
                            "rounded-[6px] border px-2.5 py-1 text-11 disabled:opacity-50",
                            confirmingDelete
                              ? "border-danger/40 bg-danger/[0.1] text-danger"
                              : "border-line-modal text-dim hover:text-danger",
                          ].join(" ")}
                        >
                          {isDeleting ? "Deleting…" : confirmingDelete ? "Confirm?" : "Delete"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer hint */}
        {indexes.length > 0 && (
          <div className="flex items-center border-t border-line px-4.5 py-3 text-[10.5px] text-dim" style={{ paddingInline: 18 }}>
            Click a row's Open button to switch the active index, or Re-scan to refresh.
          </div>
        )}
      </div>
    </div>
  );
}
