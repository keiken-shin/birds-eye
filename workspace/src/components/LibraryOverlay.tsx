import { useState, useEffect, useRef } from "react";
import { ArchiveRestore, Undo2 } from "lucide-react";
import {
  recentlyCleaned,
  recentlyMoved,
  restoreCleanupEntry,
  restoreMove,
  type NativeCleanupLogEntry,
  type NativeRelocationLogEntry,
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
  const [moves, setMoves] = useState<NativeRelocationLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [restoringMoveId, setRestoringMoveId] = useState<number | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (overlay !== "library" || !indexPath) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        // Both halves of undo: what was deleted, and what was moved. The move log is
        // durable in SQLite, so it is still here after a restart — the toast is not.
        const cleaned = await recentlyCleaned(indexPath, 200, 0);
        if (id !== reqId.current) return;
        setEntries(cleaned);
        // The move log must never take the cleanup list down with it. Getting a deleted
        // file back is the more safety-critical half, so it is fetched first and this one
        // degrades to empty rather than failing the whole panel.
        const moved = await recentlyMoved(indexPath, 200, 0).catch(() => []);
        if (id === reqId.current) setMoves(moved);
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

  const restoreMoved = async (entry: NativeRelocationLogEntry) => {
    if (!indexPath) return;
    setRestoringMoveId(entry.id);
    setError(null);
    try {
      await restoreMove(indexPath, entry.id);
      const id = ++reqId.current;
      const result = await recentlyMoved(indexPath, 200, 0);
      if (id === reqId.current) setMoves(result);
      await refreshData();
    } catch (e) {
      // The backend writes its refusals as finished sentences, so show it as-is.
      setError(String(e));
    } finally {
      setRestoringMoveId(null);
    }
  };

  if (overlay !== "library") return null;

  // `move_pending` is a real, undoable move whose identity was never recorded —
  // a crash between opening the log row and finishing it. Filtering to "moved"
  // alone made exactly those rows invisible, which is the opposite of what the
  // pending state exists for. `restore_pending` is a put-back that was claimed
  // but not confirmed; retrying it converges rather than repeating a refusal.
  const MOVE_RESTORABLE = new Set(["moved", "move_pending", "restore_pending"]);
  const movable = moves.filter((m) => MOVE_RESTORABLE.has(m.restore_status));
  const restorable =
    entries.filter((e) => RESTORABLE.has(e.restore_status)).length + movable.length;
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
        {!loading && movable.length > 0 && (
          <div className="mt-5">
            <div className="mb-1.5 text-115 font-medium text-ink">Moved files</div>
            <div className="mb-3 text-105 leading-relaxed text-dim">
              Moves are logged too, so they survive closing the app. Restore puts a file back
              where it came from — nothing already sitting there is overwritten.
            </div>
            <div className="flex flex-col gap-2">
              {movable.map((entry) => {
                const isRestoring = restoringMoveId === entry.id;
                return (
                  <Card key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary-dim text-primary-ink">
                      <Undo2 size={15} strokeWidth={2} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-125 font-medium text-ink">
                          {lastSegment(entry.to_path)}
                        </span>
                        {/* A pending row is a move Bird's Eye was in the middle
                            of when it stopped. Tagging it MOVED like any other
                            would be a small lie on the one row where the state
                            is genuinely uncertain. */}
                        <Tag tone={entry.restore_status === "moved" ? "blue" : "amber"}>
                          {entry.restore_status === "moved" ? "MOVED" : "INTERRUPTED"}
                        </Tag>
                      </div>
                      <div className="mono truncate text-105 text-dim" title={entry.from_path}>
                        was {entry.from_path}
                      </div>
                    </div>
                    <span className="mono flex-none text-115 font-semibold text-ink-soft">
                      {formatBytes(entry.size)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-none"
                      disabled={isRestoring || restoringMoveId !== null}
                      onClick={() => void restoreMoved(entry)}
                    >
                      {isRestoring ? "Putting back…" : "Put back"}
                    </Button>
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </OverlayShell>
  );
}
