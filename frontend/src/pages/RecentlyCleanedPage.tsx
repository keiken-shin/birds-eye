import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import {
  recentlyCleaned,
  restoreCleanupEntry,
  REASON_LABELS,
  type NativeCleanupLogEntry,
} from "../nativeClient";
import { formatBytes } from "../domain";

export function RecentlyCleanedPage() {
  const { workspaceIndexPath, setRuntimeMessage } = useScanContext();
  const [entries, setEntries] = useState<NativeCleanupLogEntry[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    if (!workspaceIndexPath) return;
    try {
      setEntries(await recentlyCleaned(workspaceIndexPath, 200, 0));
    } catch (e) {
      setRuntimeMessage(`Failed to load cleanup log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [workspaceIndexPath, setRuntimeMessage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const restore = useCallback(
    async (id: number) => {
      if (!workspaceIndexPath) return;
      setBusyId(id);
      try {
        await restoreCleanupEntry(workspaceIndexPath, id);
        await reload();
      } catch (e) {
        setRuntimeMessage(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [workspaceIndexPath, reload, setRuntimeMessage]
  );

  if (!workspaceIndexPath) {
    return (
      <section className="px-[42px] pb-[118px] pt-6">
        <p className="text-sm text-muted">
          No index loaded. <Link to="/library" className="text-primary underline">Open Library</Link>.
        </p>
      </section>
    );
  }

  return (
    <section className="relative z-[1] min-w-0 px-[42px] pb-[118px] pt-6 max-sm:px-4">
      <header className="mb-4 grid gap-2 border-t border-primary/20 pt-5">
        <p className="m-0 text-13 font-bold uppercase text-accent">Recently cleaned / restore log</p>
        <h2 className="text-[clamp(24px,2.6vw,40px)] font-black uppercase leading-[0.95] text-primary">
          Nothing is ever gone
        </h2>
      </header>

      {entries.length === 0 ? (
        <p className="text-sm text-muted">No cleanup history yet.</p>
      ) : (
        <ul className="grid gap-1">
          {entries.map((e) => {
            const restorable = e.restore_status === "in_recycle_bin";
            return (
              <li key={e.id} className="flex items-center justify-between gap-3 border border-white/10 px-3 py-2">
                <span className="truncate text-12 text-white/80">{e.original_path}</span>
                <span className="shrink-0 text-11 text-white/40">
                  {REASON_LABELS[e.reason] ?? e.reason} · {formatBytes(e.size)}
                </span>
                {restorable ? (
                  <button
                    type="button"
                    disabled={busyId === e.id}
                    onClick={() => void restore(e.id)}
                    className="shrink-0 border border-primary/50 px-3 py-0.5 font-mono text-10 uppercase text-primary disabled:opacity-40"
                  >
                    Restore
                  </button>
                ) : (
                  <span className="shrink-0 font-mono text-10 uppercase text-white/30">
                    {e.restore_status}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
