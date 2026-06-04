import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import { formatBytes } from "../domain";
import {
  listDiscoveries,
  confirmDiscovery,
  rejectDiscovery,
  confirmDiscoveryPattern,
  rejectDiscoveryPattern,
  DISCOVERY_KIND_LABELS,
  type NativeDiscovery,
} from "../nativeClient";

const KINDS = ["derivedFrom-pattern", "backupOf-pair"];

function candidateLabel(d: NativeDiscovery): string {
  try {
    const p = JSON.parse(d.payload) as Record<string, string>;
    if (d.kind === "derivedFrom-pattern") return `${p.derivative_path} ← ${p.source_path}`;
    if (d.kind === "backupOf-pair") return `${p.backup_path} ⇄ ${p.origin_path}`;
  } catch {
    /* fall through */
  }
  return `discovery #${d.id}`;
}

export function DiscoveriesPage() {
  const { workspaceIndexPath, setRuntimeMessage } = useScanContext();
  const [byKind, setByKind] = useState<Record<string, NativeDiscovery[]>>({});
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!workspaceIndexPath) return;
    try {
      const entries: Record<string, NativeDiscovery[]> = {};
      for (const kind of KINDS) {
        entries[kind] = await listDiscoveries(workspaceIndexPath, kind, 30);
      }
      setByKind(entries);
    } catch (e) {
      setRuntimeMessage(`Failed to load discoveries: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [workspaceIndexPath, setRuntimeMessage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await reload();
      } catch (e) {
        setRuntimeMessage(`Discovery action failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [reload, setRuntimeMessage]
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

  const total = Object.values(byKind).reduce((n, list) => n + list.length, 0);

  return (
    <section className="relative z-[1] min-w-0 px-[42px] pb-[118px] pt-6 max-sm:px-4">
      <header className="mb-4 grid gap-2 border-t border-primary/20 pt-5">
        <p className="m-0 text-13 font-bold uppercase text-accent">Discoveries / confirm inferences</p>
        <h2 className="text-[clamp(24px,2.6vw,40px)] font-black uppercase leading-[0.95] text-primary">
          You decide what&apos;s true
        </h2>
        <span className="max-w-[760px] text-sm text-muted">
          Confirming a suggestion writes a high-confidence fact; rejecting blocks it from coming back.
        </span>
      </header>

      {total === 0 && <p className="text-sm text-muted">No pending discoveries.</p>}

      {KINDS.map((kind) => {
        const items = byKind[kind] ?? [];
        if (items.length === 0) return null;
        return (
          <div key={kind} className="mb-6">
            <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2">
              <h3 className="font-mono text-11 uppercase tracking-[1px] text-white/50">
                {DISCOVERY_KIND_LABELS[kind] ?? kind} · {items.length}
              </h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => confirmDiscoveryPattern(workspaceIndexPath, kind))}
                  className="border border-accent/60 px-3 py-0.5 font-mono text-10 uppercase text-accent disabled:opacity-40"
                >
                  Confirm all
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => rejectDiscoveryPattern(workspaceIndexPath, kind))}
                  className="border border-white/20 px-3 py-0.5 font-mono text-10 uppercase text-white/50 disabled:opacity-40"
                >
                  Reject all
                </button>
              </div>
            </div>

            <ul className="grid gap-1">
              {items.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 border border-white/10 px-3 py-2">
                  <span className="truncate text-12 text-white/80">{candidateLabel(d)}</span>
                  <span className="shrink-0 text-11 text-white/40">
                    {(d.confidence * 100).toFixed(0)}% · {formatBytes(d.potential_bytes_unlocked)}
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => confirmDiscovery(workspaceIndexPath, d.id))}
                      className="border border-accent/60 px-2 py-0.5 font-mono text-10 uppercase text-accent disabled:opacity-40"
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => rejectDiscovery(workspaceIndexPath, d.id))}
                      className="border border-white/20 px-2 py-0.5 font-mono text-10 uppercase text-white/50 disabled:opacity-40"
                    >
                      Reject
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
