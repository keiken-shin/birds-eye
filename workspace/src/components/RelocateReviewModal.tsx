import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, AlertTriangle } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import {
  buildRelocationPlan,
  executeRelocationPlan,
  type NativeRelocationPlan,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { Button } from "./ui/Button";
import { OverlayShell } from "./ui/OverlayShell";
import { SectionLabel } from "./ui/Card";

/**
 * The relocate review gate: the last stop before staged moves touch disk.
 * On open, re-verifies the staged moves on the Rust side (files can vanish or
 * a destination can fill up between staging and now) and shows both what
 * survives and what got dropped. Confirming executes the plan and reports
 * per-file failures without losing the ones that succeeded.
 */
export function RelocateReviewModal() {
  const { review, closeReview, stagedMoves, toggleStagedMove, clearStagedMoves, indexPath, setUndo } =
    useWorkspace();
  const { activeEntry, refreshData } = useIndexData();
  const { view: scanView, enqueue } = useScanController();

  const [plan, setPlan] = useState<NativeRelocationPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Array<{ path: string; reason: string }>>([]);
  const reqId = useRef(0);
  // Snapshot, read only when the build effect fires — NOT a dependency of that
  // effect. execute() mutates stagedMoves on completion (fully clears on total
  // success, prunes only the succeeded entries on partial failure); if the
  // effect depended on stagedMoves directly, that mutation would re-trigger it
  // while the modal is still showing the failure list, wiping setFailures(...)
  // and rebuilding a plan out from under the user.
  const stagedMovesRef = useRef(stagedMoves);
  stagedMovesRef.current = stagedMoves;

  // Guarded on review === "relocate" specifically: a plain truthiness check
  // would also fire while a "clean" review is open, and stagedMoves has
  // nothing to do with buildCleanupPlan's delete-scope shape.
  useEffect(() => {
    if (review !== "relocate" || !indexPath) return;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setPlan(null);
    setFailures([]);

    void (async () => {
      try {
        const built = await buildRelocationPlan(
          indexPath,
          stagedMovesRef.current.map((m) => ({
            file_id: m.fileId,
            from: m.path,
            to: m.to,
            discovery_id: m.discoveryId,
          }))
        );
        if (id !== reqId.current) return;
        setPlan(built);
      } catch (e) {
        if (id !== reqId.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, indexPath]);

  const execute = useCallback(async () => {
    // Once this plan has recorded a failure the button below is disabled, so
    // this guard only protects against some other trigger re-running it —
    // re-executing a spent plan (every item already "moved"/"failed", none
    // "planned") is a no-op on the Rust side ({moved: 0, pairs: [], failed:
    // []}), and that no-op must never be read as a fresh success.
    if (!plan || !indexPath || failures.length) return;
    setBusy(true);
    setError(null);
    try {
      const result = await executeRelocationPlan(indexPath, plan.plan_id);
      if (result.moved === 0 && result.pairs.length === 0 && result.failed.length === 0) {
        setError("Nothing was moved. Close this review and reopen it from the tray to retry.");
        return;
      }
      setFailures(result.failed);
      if (result.pairs.length) {
        setUndo({ kind: "relocate", pairs: result.pairs });
      }
      if (result.failed.length) {
        // Partial failure: only drop the moves that actually landed on disk,
        // so the still-unmoved files stay staged and the tray stays reopenable
        // for a retry. This can't double-move a file — reopening the review
        // re-runs buildRelocationPlan, which re-verifies each staged path
        // against the index's deleted_at column and drops anything already
        // moved into `plan.dropped` instead of feeding it to execute again.
        const movedFrom = new Set(result.pairs.map((p) => p.from));
        for (const m of stagedMoves) {
          if (movedFrom.has(m.path)) toggleStagedMove(m);
        }
      } else {
        clearStagedMoves();
      }
      await refreshData();
      // Unlike MoveDialog, always enqueue — the scan queue FIFOs rather than
      // requiring idle, so a heal is always in line once files move. Root must
      // be the index's own scan root: start_scan_job_for_root derives the
      // index path from it, so a staged file's own path would scan a bogus,
      // unrelated index instead of healing this one.
      const root = activeEntry?.root_path ?? null;
      if (root) enqueue(root, "metadata");
      if (!result.failed.length) closeReview();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    plan,
    indexPath,
    failures,
    setUndo,
    stagedMoves,
    toggleStagedMove,
    clearStagedMoves,
    refreshData,
    enqueue,
    activeEntry,
    closeReview,
  ]);

  if (review !== "relocate") return null;

  const scanning = scanView.status === "scanning";

  // Guard the header's X the same way Cancel already is: closeReview alone
  // would let the X unmount the modal mid-execute, so a partial-failure
  // result lands in setFailures(...) on a component that no longer renders —
  // the failure list the user is meant to see is silently lost. Mirrors
  // ReviewModal's `close` and MoveDialog's guarded onClose.
  const close = () => {
    if (!busy) closeReview();
  };

  return (
    <OverlayShell
      title="Review before moving"
      meta={plan ? `${plan.total_files} file${plan.total_files === 1 ? "" : "s"} · ${formatBytes(plan.total_bytes)}` : undefined}
      onClose={close}
      width={640}
      locked={busy}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 flex-1 truncate text-105 text-faint">
            {scanning
              ? "A scan is running — wait for it to finish before moving files."
              : failures.length
              ? "Some files couldn't be moved. Close this review and reopen it from the tray to retry them."
              : "Nothing is deleted — files are moved, and Undo puts them back."}
          </p>
          <div className="flex flex-none gap-1.5">
            <Button variant="ghost" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={ArrowRight}
              // Once a partial failure lands, this exact plan is spent — every
              // item is now "moved" or "failed", none "planned" — so re-running
              // it would be a silent no-op (see the guard in execute()).
              // Disabling here means the user always closes and reopens for a
              // fresh plan built from the files still staged, rather than
              // hitting that no-op at all.
              disabled={busy || loading || !plan || plan.total_files === 0 || scanning || failures.length > 0}
              onClick={() => void execute()}
            >
              {busy ? "Moving…" : scanning ? "Scan running" : "Move files"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-4.5 py-3.5">
        {loading ? (
          <>
            <SectionLabel className="mb-1">Will be moved</SectionLabel>
            {[0, 1, 2].map((n) => (
              <div key={n} className="h-8 animate-pulse rounded-[7px] bg-inset" />
            ))}
          </>
        ) : error ? (
          <p className="text-125 text-danger">{error}</p>
        ) : plan ? (
          <>
            <SectionLabel>
              {plan.total_files} file{plan.total_files === 1 ? "" : "s"} ·{" "}
              {formatBytes(plan.total_bytes)}
            </SectionLabel>

            {plan.total_files === 0 ? (
              <p className="text-115 text-faint">Nothing left to move — see below.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {plan.items.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-115">
                    <span className="min-w-0 flex-1 truncate text-dim" title={item.from_path}>
                      {item.from_path}
                    </span>
                    <ArrowRight size={11} className="flex-none text-faint" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-ink" title={item.to_path}>
                      {item.to_path}
                    </span>
                    <span className="mono flex-none text-105 text-faint">
                      {formatBytes(item.size)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {plan.dropped.length ? (
              <div className="rounded-[9px] border border-warn/40 bg-warn/10 p-2.5">
                <p className="flex items-center gap-1.5 text-115 text-warn">
                  <AlertTriangle size={12} className="flex-none" aria-hidden />
                  {plan.dropped.length} file{plan.dropped.length === 1 ? "" : "s"} dropped since you
                  staged {plan.dropped.length === 1 ? "it" : "them"}
                </p>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {plan.dropped.map((d) => (
                    <li key={d.path} className="truncate text-105 text-dim" title={d.path}>
                      {d.path} — {d.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {failures.length ? (
              <div className="rounded-[9px] border border-danger/40 bg-danger/10 p-2.5">
                <p className="text-115 text-danger">
                  {failures.length} file{failures.length === 1 ? "" : "s"} could not be moved
                </p>
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {failures.map((f) => (
                    <li key={f.path} className="truncate text-105 text-dim" title={f.path}>
                      {f.path} — {f.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </OverlayShell>
  );
}
