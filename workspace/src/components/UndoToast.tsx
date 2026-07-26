import { useCallback, useEffect, useState } from "react";
import { CircleCheck, TriangleAlert, X } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { moveFiles, restoreCleanupEntry } from "@bridge/nativeClient";
import { reversePairs } from "../lib/undo";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { Button, IconButton } from "./ui/Button";

export function UndoToast() {
  const { undo, setUndo, indexPath } = useWorkspace();
  const { refreshData } = useIndexData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onUndo = useCallback(async () => {
    if (!indexPath || busy || !undo) return;
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
  }, [indexPath, busy, undo, setUndo, refreshData]);

  // A new (or cleared) undo starts with a clean slate — never show a stale failure.
  useEffect(() => {
    setError(null);
  }, [undo]);

  useEffect(() => {
    // Don't auto-dismiss while showing a restore failure — the user must see it.
    if (!undo || error) return;
    const t = setTimeout(() => setUndo(null), 9000);
    return () => clearTimeout(t);
  }, [undo, error, setUndo]);

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

  return (
    <div className="be-in absolute bottom-[74px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2.5 rounded-[10px] border border-line-modal bg-overlay px-3.5 py-2.5 shadow-[0_14px_40px_-10px_rgba(0,0,0,0.7)]">
      {error ? (
        <TriangleAlert size={15} className="flex-none text-warn" aria-hidden />
      ) : (
        <CircleCheck size={15} className="flex-none text-primary-ink" aria-hidden />
      )}
      <span className="text-125 text-ink-soft">
        {error ??
          (undo.kind === "relocate" ? (
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
      <Button variant="subtle" size="sm" disabled={busy || nothingToUndo} onClick={() => void onUndo()}>
        {busy ? "Restoring…" : "Undo"}
      </Button>
      <IconButton icon={X} label="Dismiss" size={13} onClick={() => setUndo(null)} />
    </div>
  );
}
