import { useCallback, useEffect, useState } from "react";
import { CircleCheck, TriangleAlert, X } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { moveFiles, restoreCleanupEntry } from "@bridge/nativeClient";
import { reversePairs } from "../lib/undo";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { Button, IconButton } from "./ui/Button";

export function UndoToast() {
  const { undo, setUndo, indexPath } = useWorkspace();
  const { refreshData } = useIndexData();
  const { view: scanView } = useScanController();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUndo = useCallback(async () => {
    if (!indexPath || busy || !undo) return;
    // Same ghost-row risk the forward move is gated on: reversing pairs mid-scan
    // can leave index rows the scan's missing-file sweep won't touch (it only
    // covers rows older than the scan's start). Block it exactly like the
    // forward path blocks "Move files".
    if (undo.kind === "relocate" && scanView.status === "scanning") return;
    setBusy(true);
    try {
      if (undo.kind === "relocate") {
        // No dedicated undo command — move_files takes (from, to) pairs, so
        // undo is just the executed pairs reversed.
        const result = await moveFiles(reversePairs(undo.pairs), indexPath);
        if (result.failed.length) {
          setError(
            `${result.failed.length} of ${undo.pairs.length} files could not be moved back — see their original folders`
          );
        } else {
          setUndo(null);
        }
        await refreshData();
        return;
      }
      let failures = 0;
      for (const id of undo.entryIds) {
        try {
          await restoreCleanupEntry(indexPath, id);
        } catch {
          failures++;
        }
      }
      if (failures) {
        setError(
          `${failures} of ${undo.entryIds.length} items could not be restored — see Recently cleaned`
        );
      } else {
        setUndo(null);
      }
      await refreshData();
    } finally {
      setBusy(false);
    }
  }, [indexPath, busy, undo, setUndo, refreshData, scanView]);

  // A new (or cleared) undo starts with a clean slate — never show a stale failure.
  useEffect(() => {
    setError(null);
  }, [undo]);

  useEffect(() => {
    // Don't auto-dismiss while showing a restore failure, or while a scan
    // blocks the relocate-undo action — the user must see why, and the
    // record of what to undo shouldn't vanish just because a scan is slow.
    if (!undo || error || (undo.kind === "relocate" && scanView.status === "scanning")) return;
    const t = setTimeout(() => setUndo(null), 9000);
    return () => clearTimeout(t);
  }, [undo, error, setUndo, scanView]);

  // ⌘Z / Ctrl-Z restores the last clean while the toast is up (text fields keep their own undo).
  useEffect(() => {
    if (!undo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      void onUndo();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, onUndo]);

  if (!undo) return null;

  const nothingToUndo = undo.kind === "relocate" ? !undo.pairs.length : !undo.entryIds.length;
  const scanBlocked = undo.kind === "relocate" && scanView.status === "scanning";

  return (
    <div className="be-in absolute bottom-[74px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-[10px] border border-line-modal bg-overlay px-3.5 py-2.5 shadow-[0_14px_40px_-10px_rgba(0,0,0,0.7)]">
      {error || scanBlocked ? (
        <TriangleAlert size={15} className="flex-none text-warn" aria-hidden />
      ) : (
        <CircleCheck size={15} className="flex-none text-primary-ink" aria-hidden />
      )}
      <span className="text-125 text-ink-soft">
        {error ??
          (scanBlocked ? (
            "A scan is running — undo will be available once it finishes."
          ) : undo.kind === "relocate" ? (
            <>
              Moved <b className="mono text-ink">{undo.pairs.length}</b> file
              {undo.pairs.length === 1 ? "" : "s"}
            </>
          ) : (
            <>
              Cleaned <b className="mono text-ink">{formatBytes(undo.freed)}</b> — moved to recycle bin
            </>
          ))}
      </span>
      <Button
        variant="subtle"
        size="sm"
        disabled={busy || nothingToUndo || scanBlocked}
        title={scanBlocked ? "A scan is running — wait for it to finish before undoing." : undefined}
        onClick={() => void onUndo()}
      >
        {busy ? "Restoring…" : "Undo"}
      </Button>
      <IconButton icon={X} label="Dismiss" size={13} onClick={() => setUndo(null)} />
    </div>
  );
}
