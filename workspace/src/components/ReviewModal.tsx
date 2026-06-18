import { useEffect, useRef, useState } from "react";
import { formatBytes, lastSegment } from "@bridge/domain";
import {
  buildCleanupPlan,
  executeCleanupPlan,
  recentlyCleaned,
  REASON_LABELS,
  type NativeCleanupCandidate,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { VERDICT_STYLES } from "../lib/verdict";

const ALL_REASONS = ["safe-derivative", "redundant-backup", "scratch", "finished-project-cruft"];
const RETENTION_DAYS = 30;

/** Drop staged paths that are descendants of another staged path, so plans don't overlap. */
function nonOverlapping(paths: string[]): string[] {
  return paths.filter(
    (p) => !paths.some((q) => q !== p && (p.startsWith(q + "/") || p.startsWith(q + "\\")))
  );
}

type PlanState = {
  planIds: number[];
  candidates: NativeCleanupCandidate[];
  totalBytes: number;
};

export function ReviewModal() {
  const { review, staged, closeReview, clearStaged, setUndo, indexPath } = useWorkspace();
  const { refreshData } = useIndexData();
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    if (!review || !indexPath) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setPlan(null);

    void (async () => {
      try {
        const targets = nonOverlapping(staged.map((s) => s.path));
        const responses = await Promise.all(
          targets.map((pathPrefix) =>
            buildCleanupPlan(indexPath, { reasons: ALL_REASONS, maxSize: null, pathPrefix })
          )
        );
        if (id !== reqId.current) return;
        const seen = new Set<string>();
        const candidates: NativeCleanupCandidate[] = [];
        for (const r of responses) {
          for (const c of r.candidates) {
            if (seen.has(c.path)) continue;
            seen.add(c.path);
            candidates.push(c);
          }
        }
        setPlan({
          planIds: responses.map((r) => r.plan_id),
          candidates,
          totalBytes: candidates.reduce((s, c) => s + Math.max(0, c.size), 0),
        });
      } catch (e) {
        if (id === reqId.current) setError(String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
  }, [review, indexPath, staged]);

  if (!review) return null;

  const confirm = async () => {
    if (!indexPath || !plan || working) return;
    setWorking(true);
    try {
      let freed = 0;
      for (const planId of plan.planIds) {
        const result = await executeCleanupPlan(indexPath, planId, RETENTION_DAYS);
        freed += result.bytes_cleaned;
      }
      // Recover the cleanup-log entry ids we just created, for one-click Undo.
      const log = await recentlyCleaned(indexPath, 500, 0);
      const planSet = new Set(plan.planIds);
      const entryIds = log
        .filter((e) => planSet.has(e.cleanup_plan_id) && e.restore_status === "in_recycle_bin")
        .map((e) => e.id);

      clearStaged();
      closeReview();
      setUndo({ entryIds, freed });
      await refreshData();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const count = plan?.candidates.length ?? 0;

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(6,7,9,.66)] backdrop-blur-[3px]"
      onClick={closeReview}
    >
      <div
        className="be-in flex max-h-[660px] w-[580px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4.5 py-4" style={{ paddingInline: 18 }}>
          <span className="text-[15px] font-semibold">Review before cleaning</span>
          <span className="mono text-11 text-dim">
            {count} {count === 1 ? "item" : "items"} · {formatBytes(plan?.totalBytes ?? 0)}
          </span>
          <button type="button" onClick={closeReview} className="ml-auto text-[16px] text-dim hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-line bg-primary/[0.08] px-4.5 py-2.5 text-[11.5px] text-primary-ink" style={{ paddingInline: 18 }}>
          ⟳ Re-verified just now — protected items are automatically excluded.
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4.5 py-3.5" style={{ paddingInline: 18 }}>
          {loading && <div className="py-6 text-center text-12 text-muted">Re-checking staged items…</div>}
          {error && <div className="py-6 text-center text-12 text-danger">{error}</div>}
          {!loading && !error && (
            <>
              <div className="mb-2.5 text-10 tracking-[0.14em] text-label">WILL BE REMOVED</div>
              {count === 0 ? (
                <div className="mb-4 text-12 italic text-label">
                  Nothing currently reclaimable in the staged scope.
                </div>
              ) : (
                <div className="mb-4.5 flex flex-col gap-2" style={{ marginBottom: 18 }}>
                  {plan!.candidates.slice(0, 200).map((c) => (
                    <div
                      key={c.path}
                      className="flex items-center gap-2.5 rounded-[9px] border border-line-modal bg-window px-3 py-2.5"
                    >
                      <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] bg-primary text-[12px] text-on-primary">
                        ✓
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-13" title={c.path}>
                          {lastSegment(c.path)}
                        </div>
                        <div className="mt-px text-[10.5px] text-dim">
                          {REASON_LABELS[c.reason] ?? c.reason}
                        </div>
                      </div>
                      <span
                        className="flex-none rounded-[5px] px-1.5 py-0.5 text-10"
                        style={{
                          color: VERDICT_STYLES.safe.tx,
                          background: VERDICT_STYLES.safe.bg,
                          border: "1px solid " + VERDICT_STYLES.safe.bd,
                        }}
                      >
                        {c.reason === "finished-project-cruft" ? "REVIEW" : "SAFE"}
                      </span>
                      <span className="mono w-[62px] flex-none text-right text-[12.5px]">
                        {formatBytes(Math.max(0, c.size))}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mb-2.5 text-10 tracking-[0.14em] text-label">DISPOSAL MODE</div>
              <div className="flex gap-2.5">
                <div className="flex-1 rounded-[9px] border border-[#2f7d4e] bg-primary/[0.1] px-3 py-2.5">
                  <div className="text-[12.5px] text-primary-ink">⦿ Quarantine</div>
                  <div className="mt-0.5 text-10 text-primary-ink opacity-80">
                    recoverable {RETENTION_DAYS} days · default
                  </div>
                </div>
                <div className="flex-1 rounded-[9px] border border-line-modal px-3 py-2.5 opacity-50">
                  <div className="text-[12.5px] text-muted">◯ Delete permanently</div>
                  <div className="mt-0.5 text-10 text-dim">future</div>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2.5 border-t border-line px-4.5 py-3" style={{ paddingInline: 18 }}>
          <span className="text-[10.5px] text-dim">↩ reversible for {RETENTION_DAYS} days via Library</span>
          <button
            type="button"
            onClick={closeReview}
            className="ml-auto rounded-[8px] border border-line-modal px-3.5 py-2 text-[12.5px] text-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={working || loading || count === 0}
            onClick={() => void confirm()}
            className="rounded-[8px] bg-primary px-4 py-2 text-[12.5px] font-semibold text-on-primary disabled:opacity-50"
          >
            {working ? "Quarantining…" : `Quarantine ${formatBytes(plan?.totalBytes ?? 0)} →`}
          </button>
        </div>
      </div>
    </div>
  );
}
