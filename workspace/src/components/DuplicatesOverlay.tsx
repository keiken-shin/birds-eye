import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "@bridge/domain";
import {
  queryNativeDuplicateFiles,
  revealInExplorer,
  type NativeDuplicateFile,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { baseName } from "../lib/discoveries";
import { computeSmartMoves, suggestKeep } from "../lib/smartMoves";
import { FilePreview } from "./FilePreview";

const GROUP_LIMIT = 100;
const FILES_PER_GROUP = 50;
const HASH_LABELS: Record<number, string> = { 0: "size match", 2: "sampled", 4: "verified" };

/**
 * The duplicates workbench (ported from the feat/intelligence DuplicateWorkbench +
 * ComparisonPanel): group list on the left, side-by-side copy comparison with media
 * previews in the middle — carousel through the copies with ‹ › — and the smart-move
 * suggestion below. "Keep this" stages the other copy to the Cleanup Tray.
 */
export function DuplicatesOverlay() {
  const { overlay, setOverlay, indexPath, toggleStaged, isStaged } = useWorkspace();
  const { overview } = useIndexData();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [files, setFiles] = useState<NativeDuplicateFile[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const groups = useMemo(
    () =>
      (overview?.duplicate_groups ?? [])
        .slice()
        .sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes)
        .slice(0, GROUP_LIMIT),
    [overview]
  );

  const open = overlay === "duplicates";

  useEffect(() => {
    if (open && selectedId === null && groups.length) setSelectedId(groups[0].id);
  }, [open, selectedId, groups]);

  useEffect(() => {
    if (!open || selectedId === null || !indexPath) return;
    const id = ++reqId.current;
    setFiles(null);
    setCursor(0);
    setError(null);
    queryNativeDuplicateFiles(indexPath, selectedId, FILES_PER_GROUP)
      .then((f) => {
        if (id === reqId.current) setFiles(f);
      })
      .catch((e) => {
        if (id === reqId.current) setError(String(e));
      });
  }, [open, selectedId, indexPath]);

  if (!open) return null;
  const close = () => setOverlay(null);

  const left = files?.[cursor];
  const right = files?.[cursor + 1];
  const keepSuggestion = files?.length ? suggestKeep(files) : null;
  const moves = files?.length ? computeSmartMoves(files) : [];

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,.66)] p-6 backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className="be-in flex h-full max-h-[820px] w-full max-w-[1180px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line bg-bar px-4 py-3">
          <span className="text-[15px] font-semibold">Duplicates workbench</span>
          <span className="mono text-11 text-dim">
            {groups.length} groups ·{" "}
            {formatBytes(groups.reduce((s, g) => s + g.reclaimable_bytes, 0))} reclaimable
          </span>
          <button type="button" onClick={close} className="ml-auto text-[15px] text-dim hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* group list */}
          <div className="flex w-[250px] flex-none flex-col border-r border-line bg-panel">
            <div className="px-3 pb-1.5 pt-3 text-10 tracking-[0.14em] text-label">GROUPS</div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {groups.map((g) => {
                const active = g.id === selectedId;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedId(g.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-[7px] px-2.5 py-2 text-left"
                    style={{
                      background: active ? "rgba(61,220,132,.1)" : "transparent",
                      border: active ? "1px solid rgba(61,220,132,.3)" : "1px solid transparent",
                    }}
                  >
                    <span className="text-12" style={{ color: active ? "var(--color-ink)" : "#aab0b8" }}>
                      {g.file_count} × {formatBytes(g.size)}
                    </span>
                    <span className="mono flex-none text-10 text-primary-ink">
                      ↑ {formatBytes(g.reclaimable_bytes)}
                    </span>
                  </button>
                );
              })}
              {!groups.length && (
                <div className="px-2 py-3 text-11 italic text-label">
                  No duplicate groups — run a scan with the Smart strategy.
                </div>
              )}
            </div>
          </div>

          {/* comparison */}
          <div className="flex min-w-0 flex-1 flex-col">
            {error && (
              <div className="m-4 rounded-[8px] border border-danger/30 bg-danger/[0.08] px-3 py-2 text-11 text-danger">
                {error}
              </div>
            )}
            {!files ? (
              <div className="flex flex-1 items-center justify-center text-12 italic text-label">
                {selectedId === null ? "Select a group to compare its copies." : "Loading copies…"}
              </div>
            ) : !left || !right ? (
              <div className="flex flex-1 items-center justify-center text-12 italic text-label">
                This group has fewer than two listed copies.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2">
                  <span className="text-10 uppercase tracking-[0.14em] text-label">copy comparison</span>
                  <span className="mono text-10 text-dim">
                    {cursor + 1}–{cursor + 2} of {files.length} copies ·{" "}
                    {HASH_LABELS[Math.max(left.hash_state, right.hash_state)]}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      disabled={cursor === 0}
                      onClick={() => setCursor((c) => Math.max(0, c - 1))}
                      className="rounded-[6px] border border-line px-2.5 py-1 text-12 text-muted disabled:opacity-40"
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      disabled={cursor + 2 >= files.length}
                      onClick={() => setCursor((c) => Math.min(files.length - 2, c + 1))}
                      className="rounded-[6px] border border-line px-2.5 py-1 text-12 text-muted disabled:opacity-40"
                    >
                      ›
                    </button>
                  </div>
                </div>

                <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto p-4">
                  {[left, right].map((f, i) => {
                    const other = i === 0 ? right : left;
                    const staged = isStaged(f.path);
                    const suggested = keepSuggestion === f.path;
                    return (
                      <div
                        key={f.path}
                        className="flex min-w-0 flex-col rounded-[11px] border p-3"
                        style={{
                          borderColor: suggested ? "rgba(61,220,132,.45)" : "var(--color-line)",
                          background: "var(--color-panel)",
                        }}
                      >
                        <FilePreview path={f.path} />
                        <div className="mb-0.5 flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-13 font-semibold">
                            {baseName(f.path)}
                          </span>
                          {suggested && (
                            <span className="flex-none rounded-[5px] border border-primary/40 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.08em] text-primary-ink">
                              suggested keep
                            </span>
                          )}
                        </div>
                        <div className="mono mb-2 break-all text-[10px] text-dim">{f.path}</div>
                        <div className="mono mb-3 flex gap-3 text-10 text-muted">
                          <span>{formatBytes(f.size)}</span>
                          <span>
                            {f.modified_at ? new Date(f.modified_at * 1000).toLocaleDateString() : "—"}
                          </span>
                          <span className="text-label">{HASH_LABELS[f.hash_state]}</span>
                        </div>
                        <div className="mt-auto flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              // Keep this copy: stage the other one (and unstage this if staged).
                              if (staged) {
                                toggleStaged({ path: f.path, name: baseName(f.path), bytes: f.size, reason: null, verdict: "review", kind: "file" });
                              }
                              if (!isStaged(other.path)) {
                                toggleStaged({ path: other.path, name: baseName(other.path), bytes: other.size, reason: null, verdict: "review", kind: "file" });
                              }
                            }}
                            className="flex-1 rounded-[7px] bg-primary py-1.5 text-11 font-semibold text-on-primary"
                          >
                            Keep this
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              toggleStaged({ path: f.path, name: baseName(f.path), bytes: f.size, reason: null, verdict: "review", kind: "file" })
                            }
                            className="flex-1 rounded-[7px] border py-1.5 text-11"
                            style={
                              staged
                                ? { borderColor: "rgba(61,220,132,.4)", color: "#7fe0a6" }
                                : { borderColor: "var(--color-line-modal)", color: "var(--color-muted)" }
                            }
                          >
                            {staged ? "✓ Staged" : "Stage"}
                          </button>
                          <button
                            type="button"
                            title="Reveal in Explorer"
                            onClick={() => void revealInExplorer(f.path).catch(() => {})}
                            className="flex-none rounded-[7px] border border-line px-2.5 py-1.5 text-11 text-muted hover:text-ink"
                          >
                            ⌖
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {moves.length > 0 && (
                  <div className="border-t border-line px-4 py-3">
                    <div className="mb-1.5 text-10 uppercase tracking-[0.14em] text-label">smart move</div>
                    {moves.map((m) => {
                      const allStaged = m.stagePaths.every((p) => isStaged(p));
                      return (
                        <div key={m.targetFolder} className="flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-12 text-ink-soft">
                              Keep <span className="mono text-primary-ink">{m.targetFolder}</span>
                            </div>
                            <div className="text-10 text-dim">{m.reason}</div>
                          </div>
                          <button
                            type="button"
                            disabled={allStaged}
                            onClick={() => {
                              for (const p of m.stagePaths) {
                                if (!isStaged(p)) {
                                  const f = files.find((x) => x.path === p);
                                  toggleStaged({ path: p, name: baseName(p), bytes: f?.size ?? 0, reason: null, verdict: "review", kind: "file" });
                                }
                              }
                            }}
                            className="flex-none rounded-[7px] border border-primary/40 px-3 py-1.5 text-11 font-semibold text-primary-ink disabled:opacity-50"
                          >
                            {allStaged ? "✓ Strays staged" : `Stage ${m.stagePaths.length} strays`}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
