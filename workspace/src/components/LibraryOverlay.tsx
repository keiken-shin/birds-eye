import { useState, useEffect, useRef } from "react";
import { recentlyCleaned, restoreCleanupEntry, type NativeCleanupLogEntry } from "@bridge/nativeClient";
import { formatBytes, lastSegment } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { useIndexData } from "../state/indexData";

export function LibraryOverlay() {
  const { overlay, setOverlay, indexPath } = useWorkspace();
  const { refreshData } = useIndexData();

  const [entries, setEntries] = useState<NativeCleanupLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (overlay !== "library" || !indexPath) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await recentlyCleaned(indexPath, 200, 0);
        if (id !== reqId.current) return;
        setEntries(result);
      } catch (e) {
        if (id === reqId.current) setError(String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
  }, [overlay, indexPath]);

  const close = () => setOverlay(null);

  const restore = async (entry: NativeCleanupLogEntry) => {
    if (!indexPath) return;
    setRestoringId(entry.id);
    setError(null);
    try {
      await restoreCleanupEntry(indexPath, entry.id);
      const id = ++reqId.current;
      const result = await recentlyCleaned(indexPath, 200, 0);
      if (id === reqId.current) setEntries(result);
      await refreshData();
    } catch (e) {
      setError(String(e));
    } finally {
      setRestoringId(null);
    }
  };

  if (overlay !== "library") return null;

  const statusPill = (status: NativeCleanupLogEntry["restore_status"]) => {
    if (status === "in_recycle_bin") {
      return (
        <span className="rounded-[5px] bg-primary/[0.15] px-1.5 py-0.5 text-10 text-primary-ink">
          In recycle bin
        </span>
      );
    }
    if (status === "restored") {
      return (
        <span className="rounded-[5px] bg-overlay px-1.5 py-0.5 text-10 text-muted border border-line-modal">
          Restored
        </span>
      );
    }
    return (
      <span className="rounded-[5px] px-1.5 py-0.5 text-10 text-dim">
        Expired
      </span>
    );
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,.66)] backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className="be-in flex max-h-[660px] w-[580px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-line px-4.5 py-4" style={{ paddingInline: 18 }}>
          <span className="text-[15px] font-semibold">Library</span>
          <span className="text-11 text-dim">recently cleaned · recoverable for 30 days</span>
          {!loading && !error && indexPath && (
            <span className="mono text-11 text-label">
              {entries.length} {entries.length === 1 ? "item" : "items"}
            </span>
          )}
          <button type="button" onClick={close} className="ml-auto text-[16px] text-dim hover:text-ink">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4.5 py-3.5" style={{ paddingInline: 18 }}>
          {loading && (
            <div className="py-6 text-center text-12 text-muted">Loading cleaned items…</div>
          )}
          {error && (
            <div className="py-3 text-12 text-danger">{error}</div>
          )}
          {!loading && !indexPath && (
            <div className="py-6 text-12 italic text-label">Scan a folder first.</div>
          )}
          {!loading && indexPath && entries.length === 0 && !error && (
            <div className="py-6 text-12 italic text-label">
              Nothing cleaned yet — quarantined items will appear here, recoverable for 30 days.
            </div>
          )}
          {!loading && entries.length > 0 && (
            <div className="flex flex-col gap-2">
              {entries.map((entry) => {
                const isRestoring = restoringId === entry.id;
                const canRestore = entry.restore_status === "in_recycle_bin";
                return (
                  <div
                    key={entry.id}
                    className="flex items-start gap-2.5 rounded-[9px] border border-line-modal bg-window px-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-13" title={entry.original_path}>
                        {lastSegment(entry.original_path)}
                      </div>
                      <div
                        className="mono mt-0.5 truncate text-[10.5px] text-dim"
                        title={entry.original_path}
                      >
                        {entry.original_path}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-10 text-muted">
                        <span className="mono">{formatBytes(entry.size)}</span>
                        <span className="text-label">·</span>
                        <span>{new Date(entry.cleaned_at * 1000).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1.5 pt-0.5">
                      {statusPill(entry.restore_status)}
                      {canRestore && (
                        <button
                          type="button"
                          disabled={isRestoring || restoringId !== null}
                          onClick={() => void restore(entry)}
                          className="rounded-[6px] border border-line-modal px-2.5 py-1 text-11 text-ink-soft hover:text-ink disabled:opacity-50"
                        >
                          {isRestoring ? "Restoring…" : "Restore"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
