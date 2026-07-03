import { useEffect, useState } from "react";
import { formatBytes } from "@bridge/domain";
import { restoreCleanupEntry } from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";

export function UndoToast() {
  const { undo, setUndo, indexPath } = useWorkspace();
  const { refreshData } = useIndexData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  });

  if (!undo) return null;

  const onUndo = async () => {
    if (!indexPath || busy) return;
    setBusy(true);
    try {
      let failures = 0;
      for (const id of undo.entryIds) {
        try {
          await restoreCleanupEntry(indexPath, id);
        } catch {
          failures++;
        }
      }
      if (failures) {
        setError(`${failures} of ${undo.entryIds.length} items could not be restored — see Library`);
      } else {
        setUndo(null);
      }
      await refreshData();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="be-in absolute bottom-[74px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-[10px] border border-line-modal bg-overlay px-3.5 py-2.5 shadow-[0_14px_40px_-10px_rgba(0,0,0,.7)]">
      <span className={error ? "text-danger" : "text-primary-ink"}>{error ? "⚠" : "✓"}</span>
      <span className="text-[12.5px]">
        {error ?? (
          <>
            Cleaned <b className="mono">{formatBytes(undo.freed)}</b> — moved to Quarantine
          </>
        )}
      </span>
      <button
        type="button"
        disabled={busy || !undo.entryIds.length}
        onClick={() => void onUndo()}
        className="ml-1.5 text-[12.5px] font-semibold text-primary disabled:opacity-40"
      >
        {busy ? "Restoring…" : "Undo"}
      </button>
      <button type="button" onClick={() => setUndo(null)} className="ml-1 text-dim hover:text-ink">
        ×
      </button>
    </div>
  );
}
