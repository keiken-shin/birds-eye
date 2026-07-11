import { useState, useEffect, useRef } from "react";
import { ArchiveRestore } from "lucide-react";
import {
  recentlyCleaned,
  restoreCleanupEntry,
  type NativeCleanupLogEntry,
} from "@bridge/nativeClient";
import { formatBytes, formatCount, lastSegment } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { useIndexData } from "../state/indexData";
import { OverlayShell } from "./ui/OverlayShell";
import { Button } from "./ui/Button";
import { Card, EmptyState } from "./ui/Card";
import { Tag } from "./ui/Chip";

type RestoreStatus = NativeCleanupLogEntry["restore_status"];

const STATUS_TAG: Record<RestoreStatus, { tone: "green" | "neutral" | "blue"; label: string }> = {
  in_recycle_bin: { tone: "green", label: "RECYCLE BIN" },
  restored: { tone: "neutral", label: "RESTORED" },
  expired: { tone: "neutral", label: "EXPIRED" },
  pending: { tone: "blue", label: "PENDING" },
};

const RESTORABLE = new Set<RestoreStatus>(["in_recycle_bin", "pending"]);

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

  const restorable = entries.filter((e) => RESTORABLE.has(e.restore_status)).length;
  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <OverlayShell
      title="Recently cleaned"
      meta={
        !loading && !error && indexPath ? `${formatCount(restorable)} restorable` : undefined
      }
      width={580}
      onClose={close}
    >
      <div className="px-4.5 py-3.5">
        <div className="mb-3 text-105 leading-relaxed text-dim">
          Everything Bird's Eye cleans goes to the Windows Recycle Bin first and is tracked here
          for 30 days — restore it with one click. Files deleted outside Bird's Eye don't appear.
        </div>
        {loading && <div className="py-6 text-center text-12 text-muted">Loading cleaned items…</div>}
        {error && <div className="py-3 text-12 text-danger">{error}</div>}
        {!loading && !indexPath && (
          <div className="py-6 text-center text-12 text-faint">
            Scan a folder first — cleaned items appear here.
          </div>
        )}
        {!loading && indexPath && entries.length === 0 && !error && (
          <EmptyState
            icon={ArchiveRestore}
            title="Nothing cleaned yet"
            hint="Items you clean land here first — restorable for 30 days before they expire."
          />
        )}
        {!loading && entries.length > 0 && (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => {
              const isRestoring = restoringId === entry.id;
              const canRestore = RESTORABLE.has(entry.restore_status);
              const tag = STATUS_TAG[entry.restore_status];
              const daysLeft =
                entry.expires_at !== null && canRestore
                  ? Math.ceil((entry.expires_at - nowSec) / 86_400)
                  : null;
              return (
                <Card key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span
                    className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg ${
                      canRestore ? "bg-primary-dim text-primary-ink" : "bg-raised text-faint"
                    }`}
                  >
                    <ArchiveRestore size={15} strokeWidth={2} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-125 font-medium text-ink">
                        {lastSegment(entry.original_path)}
                      </span>
                      <Tag tone={tag.tone}>{tag.label}</Tag>
                    </div>
                    <div className="mono truncate text-105 text-dim" title={entry.original_path}>
                      {entry.original_path}
                    </div>
                  </div>
                  <div className="flex flex-none flex-col items-end gap-0.5">
                    <span className="mono text-115 font-semibold text-ink-soft">
                      {formatBytes(entry.size)}
                    </span>
                    {daysLeft !== null && daysLeft > 0 ? (
                      <span className="mono text-105 text-dim">expires in {daysLeft}d</span>
                    ) : null}
                  </div>
                  {canRestore ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-none"
                      disabled={isRestoring || restoringId !== null}
                      onClick={() => void restore(entry)}
                    >
                      {isRestoring ? "Restoring…" : "Restore"}
                    </Button>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </OverlayShell>
  );
}
