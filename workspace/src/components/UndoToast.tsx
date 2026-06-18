import { useEffect, useState } from "react";
import { formatBytes } from "@bridge/domain";
import { restoreCleanupEntry } from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";

export function UndoToast() {
  const { undo, setUndo, indexPath } = useWorkspace();
  const { refreshData } = useIndexData();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 9000);
    return () => clearTimeout(t);
  }, [undo, setUndo]);

  if (!undo) return null;

  const onUndo = async () => {
    if (!indexPath || busy) return;
    setBusy(true);
    try {
      for (const id of undo.entryIds) {
        await restoreCleanupEntry(indexPath, id).catch(() => {});
      }
      setUndo(null);
      await refreshData();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="be-in absolute bottom-[74px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-[10px] border border-line-modal bg-overlay px-3.5 py-2.5 shadow-[0_14px_40px_-10px_rgba(0,0,0,.7)]">
      <span className="text-primary-ink">✓</span>
      <span className="text-[12.5px]">
        Cleaned <b className="mono">{formatBytes(undo.freed)}</b> — moved to Quarantine
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
