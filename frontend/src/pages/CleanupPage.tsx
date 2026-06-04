import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import { FileProvenance } from "../components/FileProvenance";
import { formatBytes } from "../domain";
import {
  buildCleanupPlan,
  executeCleanupPlan,
  REASON_LABELS,
  type NativeCleanupCandidate,
  type NativeCleanupPlan,
  type NativeCleanupResult,
} from "../nativeClient";

const ALL_REASONS = ["safe-derivative", "redundant-backup", "scratch", "finished-project-cruft"];

export function CleanupPage() {
  const { workspaceIndexPath, setRuntimeMessage } = useScanContext();
  const [selectedReasons, setSelectedReasons] = useState<string[]>(ALL_REASONS);
  const [plan, setPlan] = useState<NativeCleanupPlan | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<NativeCleanupResult | null>(null);
  const [busy, setBusy] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, NativeCleanupCandidate[]>();
    for (const c of plan?.candidates ?? []) {
      const list = map.get(c.reason) ?? [];
      list.push(c);
      map.set(c.reason, list);
    }
    return [...map.entries()];
  }, [plan]);

  const build = useCallback(async () => {
    if (!workspaceIndexPath) return;
    setBusy(true);
    setResult(null);
    try {
      setPlan(await buildCleanupPlan(workspaceIndexPath, { reasons: selectedReasons }));
    } catch (e) {
      setRuntimeMessage(`Cleanup plan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [workspaceIndexPath, selectedReasons, setRuntimeMessage]);

  const execute = useCallback(async () => {
    if (!workspaceIndexPath || !plan) return;
    setBusy(true);
    try {
      const retention = Number(localStorage.getItem("be.ontology.retentionDays")) || undefined;
      const r = await executeCleanupPlan(workspaceIndexPath, plan.plan_id, retention);
      setResult(r);
      setPlan(null);
      setConfirming(false);
    } catch (e) {
      setConfirming(false);
      setRuntimeMessage(`Cleanup execution failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [workspaceIndexPath, plan, setRuntimeMessage]);

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
        <p className="m-0 text-13 font-bold uppercase text-accent">Cleanup / reclaimable mass</p>
        <h2 className="text-[clamp(24px,2.6vw,40px)] font-black uppercase leading-[0.95] text-primary">
          Brave-enough cleanup
        </h2>
        <span className="max-w-[760px] text-sm text-muted">
          Every candidate is recycle-bin-first and reversible from{" "}
          <Link to="/recently-cleaned" className="text-primary underline">Recently Cleaned</Link>.
        </span>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {ALL_REASONS.map((r) => {
          const on = selectedReasons.includes(r);
          return (
            <button
              key={r}
              type="button"
              onClick={() =>
                setSelectedReasons((prev) =>
                  prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
                )
              }
              className={`border px-3 py-1 font-mono text-11 uppercase ${
                on ? "border-accent text-accent" : "border-white/20 text-white/40"
              }`}
            >
              {REASON_LABELS[r] ?? r}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => void build()}
          disabled={busy || selectedReasons.length === 0}
          className="border border-primary/50 px-4 py-1 font-mono text-11 font-black uppercase text-primary disabled:opacity-40"
        >
          Build plan
        </button>
      </div>

      {result && (
        <div className="mb-4 border border-accent/40 bg-accent/5 px-4 py-3 text-sm text-accent">
          Cleaned {result.cleaned} file{result.cleaned === 1 ? "" : "s"} ·{" "}
          {formatBytes(result.bytes_cleaned)} reclaimed
          {result.failed.length > 0 && ` · ${result.failed.length} failed`}
        </div>
      )}

      {plan && (
        <>
          <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
            <span className="text-sm text-muted">
              {plan.total_files} file{plan.total_files === 1 ? "" : "s"} ·{" "}
              {formatBytes(plan.total_bytes)} reclaimable
            </span>
            <button
              type="button"
              disabled={busy || plan.total_files === 0}
              onClick={() => setConfirming(true)}
              className="border border-red-400/60 px-4 py-1 font-mono text-11 font-black uppercase text-red-300 disabled:opacity-40"
            >
              Recycle {plan.total_files} file{plan.total_files === 1 ? "" : "s"}
            </button>
          </div>

          {grouped.map(([reason, items]) => (
            <div key={reason} className="mb-5">
              <h3 className="mb-2 font-mono text-11 uppercase tracking-[1px] text-white/50">
                {REASON_LABELS[reason] ?? reason} · {items.length}
              </h3>
              <ul className="grid gap-1">
                {items.map((c) => (
                  <li key={c.file_id} className="border border-white/10 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-12 text-white/80">{c.path}</span>
                      <span className="shrink-0 text-11 text-white/40">{formatBytes(c.size)}</span>
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === c.file_id ? null : c.file_id)}
                        className="shrink-0 border border-white/20 px-2 py-0.5 font-mono text-10 uppercase text-white/60"
                      >
                        {expanded === c.file_id ? "Hide" : "Why?"}
                      </button>
                    </div>
                    {expanded === c.file_id && (
                      <FileProvenance
                        indexPath={workspaceIndexPath}
                        fileId={c.file_id}
                        onChanged={() => void build()}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {confirming && plan && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/70">
          <div className="max-w-[440px] border border-primary/40 bg-overlay p-6">
            <h3 className="mb-2 text-lg font-black uppercase text-primary">Confirm cleanup</h3>
            <p className="mb-4 text-sm text-muted">
              {plan.total_files} file{plan.total_files === 1 ? "" : "s"} ({formatBytes(plan.total_bytes)})
              will be moved to the recycle bin. You can restore them from Recently Cleaned.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="border border-white/20 px-4 py-1 font-mono text-11 uppercase text-white/60"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void execute()}
                className="border border-red-400/60 px-4 py-1 font-mono text-11 font-black uppercase text-red-300 disabled:opacity-40"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
