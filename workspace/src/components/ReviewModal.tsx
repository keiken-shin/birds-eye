import { useEffect, useRef, useState } from "react";
import { ArrowRight, Lock, RefreshCw, Square, SquareCheck, Undo2 } from "lucide-react";
import { formatBytes, formatCount, lastSegment } from "@bridge/domain";
import {
  buildCleanupPlan,
  executeCleanupPlan,
  recentlyCleaned,
  trashFiles,
  REASON_LABELS,
  type NativeCleanupCandidate,
  type NativeTrashFailure,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { OverlayShell } from "./ui/OverlayShell";
import { Button } from "./ui/Button";
import { Card, SectionLabel } from "./ui/Card";
import { Tag, VerdictTag } from "./ui/Chip";

const ALL_REASONS = ["safe-derivative", "redundant-backup", "scratch", "finished-project-cruft"];
const RETENTION_DAYS = 30;
const CANDIDATE_CAP = 200;

/** Drop staged paths that are descendants of another staged path, so plans don't overlap. */
function nonOverlapping(paths: string[]): string[] {
  return paths.filter(
    (p) => !paths.some((q) => q !== p && (p.startsWith(q + "/") || p.startsWith(q + "\\")))
  );
}

/** Whether `path` is `prefix` itself or lives underneath it. */
function isUnder(path: string, prefix: string) {
  return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "\\");
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
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrides, setOverrides] = useState<Set<string>>(new Set());
  const reqId = useRef(0);

  useEffect(() => {
    if (!review || !indexPath) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setPlan(null);
    setOverrideOpen(false);
    setOverrides(new Set());

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

  const count = plan?.candidates.length ?? 0;
  const totalBytes = plan?.totalBytes ?? 0;
  // Honest partition: a staged item is held back when re-verification yielded no
  // plan candidates for it — every protected item (the backend hard-excludes
  // those), plus anything else the safety predicate declined.
  const heldBack = plan
    ? staged.filter(
        (s) => s.verdict === "protected" || !plan.candidates.some((c) => isUnder(c.path, s.path))
      )
    : [];
  const overriddenItems = heldBack.filter((s) => overrides.has(s.path));
  const overrideCount = overriddenItems.length;
  const overrideBytes = overriddenItems.reduce((sum, s) => sum + Math.max(0, s.bytes), 0);
  const totalItems = count + overrideCount;
  const skeletonRows = Math.min(3, Math.max(2, staged.length));

  const toggleOverride = (path: string) =>
    setOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const confirm = async () => {
    if (!indexPath || !plan || working) return;
    if (count === 0 && overrideCount === 0) return;
    setWorking(true);
    setError(null);
    try {
      // 1. Plan candidates go through the audited quarantine flow, as today.
      let freed = 0;
      let entryIds: number[] = [];
      if (count > 0) {
        for (const planId of plan.planIds) {
          const result = await executeCleanupPlan(indexPath, planId, RETENTION_DAYS);
          freed += result.bytes_cleaned;
        }
        // Recover the cleanup-log entry ids we just created, for one-click Undo.
        const log = await recentlyCleaned(indexPath, 500, 0);
        const planSet = new Set(plan.planIds);
        entryIds = log
          .filter((e) => planSet.has(e.cleanup_plan_id) && e.restore_status === "in_recycle_bin")
          .map((e) => e.id);
      }

      // 2. Explicit user overrides bypass the predicate and go to the recycle bin.
      let trashFailed: NativeTrashFailure[] = [];
      if (overrideCount > 0) {
        const result = await trashFiles(
          overriddenItems.map((s) => s.path),
          indexPath
        );
        trashFailed = result.failed;
      }

      if (trashFailed.length > 0) {
        // Partial result: stay open, keep only the failed overrides checked so a
        // retry doesn't re-recycle what already went through.
        const failedSet = new Set(trashFailed.map((f) => f.path));
        setOverrides(new Set(overriddenItems.filter((s) => failedSet.has(s.path)).map((s) => s.path)));
        if (entryIds.length > 0) setUndo({ entryIds, freed });
        setError(
          `${formatCount(trashFailed.length)} of ${formatCount(overrideCount)} overrides could not be recycled — ` +
            trashFailed
              .slice(0, 3)
              .map((f) => `${lastSegment(f.path)}: ${f.reason}`)
              .join(" · ") +
            (trashFailed.length > 3 ? " · …" : "")
        );
        await refreshData();
        return;
      }

      clearStaged();
      closeReview();
      // Undo covers only the audited cleanup-log entries — recycled overrides
      // are restored from the Windows Recycle Bin, not from here.
      if (entryIds.length > 0 || freed > 0) setUndo({ entryIds, freed });
      await refreshData();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };

  const close = () => {
    if (!working) closeReview();
  };

  return (
    <OverlayShell
      title="Review before cleaning"
      meta={
        plan
          ? `${formatCount(totalItems)} ${totalItems === 1 ? "item" : "items"} · ${formatBytes(totalBytes + overrideBytes)}`
          : undefined
      }
      width={580}
      locked={working}
      onClose={close}
      footer={
        <div className="flex items-center gap-2.5">
          <span className="flex min-w-0 items-center gap-1.5 text-105 text-dim">
            <Undo2 size={12} className="flex-none" aria-hidden />
            <span className="truncate">
              Undo anytime · restorable {RETENTION_DAYS} days from Recently cleaned
            </span>
          </span>
          <Button variant="ghost" className="ml-auto flex-none" disabled={working} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="flex-none"
            disabled={working || loading || !plan || (count === 0 && overrideCount === 0)}
            onClick={() => void confirm()}
          >
            {working ? (
              count > 0 ? (
                "Quarantining…"
              ) : (
                "Recycling…"
              )
            ) : overrideCount > 0 ? (
              count > 0 ? (
                <>
                  Quarantine <span className="mono">{formatBytes(totalBytes)}</span> · Recycle{" "}
                  <span className="mono">{formatBytes(overrideBytes)}</span>
                </>
              ) : (
                <>
                  Recycle <span className="mono">{formatBytes(overrideBytes)}</span>
                </>
              )
            ) : (
              <>
                Quarantine <span className="mono">{formatBytes(totalBytes)}</span>
              </>
            )}
            <ArrowRight size={14} aria-hidden />
          </Button>
        </div>
      }
    >
      <div className="flex items-center gap-2 border-b border-line bg-primary-wash px-4.5 py-2.5 text-115 text-primary-ink">
        <RefreshCw size={13} className="flex-none" aria-hidden />
        {loading
          ? "Re-verifying staged items — protected items are held back automatically."
          : "Re-verified just now — protected items are held back automatically."}
      </div>

      <div className="px-4.5 py-3.5">
        {loading && (
          <>
            <SectionLabel className="mb-2.5">Will be removed</SectionLabel>
            <div className="flex flex-col gap-2" aria-hidden>
              {Array.from({ length: skeletonRows }, (_, i) => (
                <Card
                  key={i}
                  className="flex items-center gap-2.5 px-3 py-2.5"
                  style={{ animation: `bePulse 1.6s ease ${i * 0.18}s infinite` }}
                >
                  <span className="h-[15px] w-[15px] flex-none rounded-[4px] bg-raised" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="h-2.5 w-1/2 rounded-full bg-raised" />
                    <span className="h-2 w-1/3 rounded-full bg-raised" />
                  </span>
                  <span className="h-2.5 w-[46px] flex-none rounded-full bg-raised" />
                </Card>
              ))}
            </div>
            <div className="mt-2.5 text-105 text-dim">Re-checking staged items against the safety rules…</div>
          </>
        )}

        {!loading && error && !plan && <div className="py-6 text-center text-12 text-danger">{error}</div>}

        {!loading && plan && (
          <>
            {error ? (
              <div className="mb-3 rounded-[9px] border border-danger/40 bg-danger/10 px-3 py-2 text-115 text-danger">
                {error}
              </div>
            ) : null}

            <SectionLabel className="mb-2.5">Will be removed</SectionLabel>
            {count === 0 ? (
              <div className="mb-4 text-12 text-faint">
                Nothing here passes the automatic safety checks.
              </div>
            ) : (
              <div className="mb-4.5 flex flex-col gap-2">
                {plan.candidates.slice(0, CANDIDATE_CAP).map((c) => (
                  <Card key={c.path} className="flex items-center gap-2.5 px-3 py-2.5">
                    <SquareCheck size={15} className="flex-none text-primary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-13 text-ink" title={c.path}>
                        {lastSegment(c.path)}
                      </div>
                      <div className="mt-px text-105 text-dim">
                        {REASON_LABELS[c.reason] ?? c.reason}
                      </div>
                    </div>
                    <VerdictTag verdict={c.reason === "finished-project-cruft" ? "review" : "safe"} />
                    <span className="mono w-[62px] flex-none text-right text-125 text-ink-soft">
                      {formatBytes(Math.max(0, c.size))}
                    </span>
                  </Card>
                ))}
                {count > CANDIDATE_CAP ? (
                  <div className="mono px-1 text-105 text-dim">
                    +{formatCount(count - CANDIDATE_CAP)} more — all included in this plan
                  </div>
                ) : null}
              </div>
            )}

            {heldBack.length > 0 ? (
              <>
                <SectionLabel className="mb-2.5">
                  <span className="text-protected-tx">Held back by safety</span>
                </SectionLabel>
                <div className="mb-2.5 flex flex-col gap-2">
                  {heldBack.map((s) => (
                    <div
                      key={s.path}
                      className="rounded-xl border border-protected-bd bg-protected-bg px-3 py-2.5 text-protected-tx"
                    >
                      <div className="flex items-center gap-2.5">
                        <Lock size={13} className="flex-none" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-125">{s.name}</div>
                          <div className="mono truncate text-9 opacity-70" title={s.path}>
                            {s.path}
                          </div>
                        </div>
                        <VerdictTag verdict={s.verdict} />
                        <span className="mono w-[62px] flex-none text-right text-125">
                          {formatBytes(Math.max(0, s.bytes))}
                        </span>
                      </div>
                      <div className="mt-1 pl-[23px] text-105 opacity-80">
                        {s.verdict === "protected"
                          ? `protected — ${s.reason ? (REASON_LABELS[s.reason] ?? s.reason) : "safety verdict"}`
                          : "nothing under this path passes the safety predicate"}
                      </div>
                    </div>
                  ))}
                </div>

                {!overrideOpen ? (
                  <div className="mb-4.5">
                    <Button variant="ghost" size="sm" disabled={working} onClick={() => setOverrideOpen(true)}>
                      Remove anyway…
                    </Button>
                  </div>
                ) : (
                  <div className="mb-4.5 flex flex-col gap-2">
                    <div className="text-105 leading-relaxed text-dim">
                      Overrides skip the safety predicate. Files go to the Windows Recycle Bin;
                      restore them from there, not from Recently cleaned.
                    </div>
                    {heldBack.map((s) => {
                      const checked = overrides.has(s.path);
                      return (
                        <button
                          key={s.path}
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          disabled={working}
                          onClick={() => toggleOverride(s.path)}
                          className={`flex items-center gap-2.5 rounded-[9px] border px-3 py-2 text-left transition-colors ${
                            checked
                              ? "border-danger/50 bg-danger/10"
                              : "border-line-modal hover:border-line-strong"
                          }`}
                        >
                          {checked ? (
                            <SquareCheck size={15} className="flex-none text-danger" aria-hidden />
                          ) : (
                            <Square size={15} className="flex-none text-faint" aria-hidden />
                          )}
                          <span className="min-w-0 flex-1 truncate text-125 text-ink" title={s.path}>
                            Remove {s.name} — <span className="mono">{formatBytes(Math.max(0, s.bytes))}</span>
                          </span>
                          {checked ? <Tag tone="red">Recycle bin</Tag> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : null}

            <SectionLabel className="mb-2.5">Disposal mode</SectionLabel>
            <div className="flex gap-2.5">
              <button
                type="button"
                role="radio"
                aria-checked="true"
                className="flex-1 rounded-[9px] border border-safe-bd bg-primary-dim px-3 py-2.5 text-left text-primary-ink"
              >
                <div className="text-125 font-medium">Quarantine</div>
                <div className="mt-0.5 text-105 opacity-80">
                  recoverable {RETENTION_DAYS} days · default
                </div>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked="false"
                disabled
                className="flex-1 rounded-[9px] border border-line-modal px-3 py-2.5 text-left opacity-50"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-125 text-muted">Delete permanently</span>
                  <Tag>coming soon</Tag>
                </div>
                <div className="mt-0.5 text-105 text-dim">frees space immediately</div>
              </button>
            </div>
          </>
        )}
      </div>
    </OverlayShell>
  );
}
