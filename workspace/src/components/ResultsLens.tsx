import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, lastSegment } from "@bridge/domain";
import {
  listSavedViews,
  runSavedView,
  searchNativeIndex,
  type NativeSavedView,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { buildIcicle, layoutIcicle } from "../lib/icicle";
import { EnableIntelligenceCard } from "./EnableIntelligenceCard";

const ROW_H = 26;
const SEARCH_LIMIT = 400;

type ResultRow = { path: string; name: string; size: number };

/**
 * Results lens — ranked list + icicle over a query. Free-text routes to `search_files`; the
 * curated saved views route to `run_saved_view` (those need enrichment, so they're gated). The
 * query is the shared `resultsQuery` global, so the command spine (M4) and the lens's own
 * controls drive the same fetch. Selecting a row feeds the Inspector; staging reuses the same
 * Cleanup Tray → Review path as the treemap (a file is just a one-path prefix the plan re-verifies).
 */
export function ResultsLens() {
  const { indexPath, ontologyEnabled, resultsQuery, runQuery, select, selected, isStaged, toggleStaged } =
    useWorkspace();
  const { dataVersion } = useIndexData();

  const [views, setViews] = useState<NativeSavedView[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(resultsQuery?.kind === "search" ? resultsQuery.text : "");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    void listSavedViews().then(setViews).catch(() => setViews([]));
  }, []);

  // Keep the local input mirroring the active search (e.g. when the command spine routes here).
  useEffect(() => {
    if (resultsQuery?.kind === "search") setText(resultsQuery.text);
  }, [resultsQuery]);

  const load = useCallback(async () => {
    setFocusPath(null);
    if (!indexPath || !resultsQuery) {
      setRows([]);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      let out: ResultRow[];
      if (resultsQuery.kind === "search") {
        const res = await searchNativeIndex(indexPath, resultsQuery.text, SEARCH_LIMIT);
        out = res.map((r) => ({ path: r.path, name: r.name, size: r.size }));
      } else {
        const res = await runSavedView(indexPath, resultsQuery.viewId);
        out = res.map((r) => ({ path: r.path, name: lastSegment(r.path), size: r.size }));
      }
      if (id !== reqId.current) return;
      out.sort((a, b) => b.size - a.size);
      setRows(out);
    } catch (e) {
      if (id === reqId.current) setError(String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
    // dataVersion: re-run after a fresh scan/enrichment so view results reflect new classifications.
  }, [indexPath, resultsQuery, dataVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitSearch = () => {
    const t = text.trim();
    if (t) runQuery({ kind: "search", text: t });
  };

  const total = useMemo(() => rows.reduce((s, r) => s + Math.max(0, r.size), 0), [rows]);
  const shown = useMemo(
    () => (focusPath ? rows.filter((r) => r.path.startsWith(focusPath)) : rows),
    [rows, focusPath]
  );

  const viewNeedsIntel = resultsQuery?.kind === "view" && !ontologyEnabled;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Query controls — free text + curated views. */}
      <div className="flex flex-none flex-col gap-2.5 border-b border-line-soft px-3.5 py-3">
        <div className="flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitSearch()}
            placeholder="Search files by name or path…"
            spellCheck={false}
            className="mono flex-1 rounded-[7px] border border-line-input bg-field px-3 py-2 text-12 text-ink placeholder:text-dim focus:border-primary/60 focus:outline-none"
          />
          <button
            type="button"
            onClick={submitSearch}
            disabled={!text.trim()}
            className="rounded-[7px] bg-primary px-3.5 py-2 text-12 font-semibold text-on-primary disabled:opacity-50"
          >
            Search
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-10 tracking-[0.12em] text-label">VIEWS</span>
          {views.map((v) => {
            const on = resultsQuery?.kind === "view" && resultsQuery.viewId === v.id;
            return (
              <button
                key={v.id}
                type="button"
                disabled={!ontologyEnabled}
                title={ontologyEnabled ? v.description : "Enable intelligence to run curated views"}
                onClick={() => runQuery({ kind: "view", viewId: v.id, viewName: v.name })}
                className="rounded-[6px] border px-2.5 py-1 text-11 disabled:opacity-40"
                style={{
                  borderColor: on ? "var(--color-primary)" : "var(--color-line-input)",
                  background: on ? "rgba(61,220,132,.12)" : "transparent",
                  color: on ? "var(--color-primary-ink)" : "var(--color-muted)",
                }}
              >
                {v.protective ? "🔒 " : ""}
                {v.name}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mx-3.5 mt-3 rounded-[8px] border border-danger/30 bg-danger/[0.08] px-3 py-2 text-11 text-danger">
          {error}
        </div>
      )}

      {viewNeedsIntel ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-[440px]">
            <div className="mb-3 text-center text-12 text-label">
              Saved views read the roles & relationships found during enrichment — enable
              intelligence to run them.
            </div>
            <EnableIntelligenceCard />
          </div>
        </div>
      ) : !resultsQuery ? (
        <div className="flex flex-1 items-center justify-center text-center text-12 italic text-label">
          Search your index, or pick a curated view above — results rank by size with an
          <br />
          icicle of where they sit in the tree.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <Icicle rows={rows} focusPath={focusPath} onFocus={setFocusPath} />

          <div className="flex flex-none items-center gap-2 border-y border-line-soft bg-bar/40 px-3.5 py-1.5 text-11 text-dim">
            <span className="text-muted">
              {loading ? "Loading…" : `${shown.length} ${shown.length === 1 ? "file" : "files"}`}
            </span>
            <span className="mono ml-auto">{formatBytes(focusPath ? shown.reduce((s, r) => s + r.size, 0) : total)}</span>
            {focusPath && (
              <button type="button" onClick={() => setFocusPath(null)} className="text-primary-ink hover:underline">
                clear filter
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!loading && shown.length === 0 ? (
              <div className="p-6 text-center text-12 italic text-label">No files match.</div>
            ) : (
              shown.map((r) => {
                const staged = isStaged(r.path);
                const sel = selected?.path === r.path;
                return (
                  <div
                    key={r.path}
                    onClick={() => select({ kind: "file", path: r.path, name: r.name, bytes: r.size })}
                    className="flex cursor-pointer items-center gap-3 border-b border-line-soft px-3.5 py-2 hover:bg-white/[0.025]"
                    style={sel ? { background: "rgba(61,220,132,.07)", boxShadow: "inset 2px 0 0 #3ddc84" } : undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-12 text-ink-soft">{r.name}</div>
                      <div className="mono truncate text-[10px] text-dim">{r.path}</div>
                    </div>
                    <span className="mono w-[68px] flex-none text-right text-12 text-muted">
                      {formatBytes(r.size)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStaged({
                          path: r.path,
                          name: r.name,
                          bytes: r.size,
                          reason: null,
                          verdict: "review",
                          kind: "file",
                        });
                      }}
                      className="flex-none rounded-[6px] border px-2 py-1 text-10"
                      style={
                        staged
                          ? { borderColor: "rgba(61,220,132,.4)", background: "rgba(61,220,132,.12)", color: "#7fe0a6" }
                          : { borderColor: "var(--color-line-input)", color: "var(--color-muted)" }
                      }
                      title={staged ? "Remove from cleanup tray" : "Add to cleanup tray (re-verified before removal)"}
                    >
                      {staged ? "✓ staged" : "+ stage"}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The icicle band — folds result paths into a hierarchy; click a cell to filter the list to it. */
function Icicle({
  rows,
  focusPath,
  onFocus,
}: {
  rows: ResultRow[];
  focusPath: string | null;
  onFocus: (path: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const rects = useMemo(() => {
    if (!rows.length || width <= 0) return [];
    return layoutIcicle(buildIcicle(rows), width, ROW_H);
  }, [rows, width]);

  const maxDepth = rects.reduce((m, r) => Math.max(m, r.depth), 0);
  const height = rects.length ? (maxDepth + 1) * ROW_H : 0;

  return (
    <div ref={ref} className="relative flex-none border-b border-line-soft" style={{ height }}>
      {rects.map((r) => {
        const active = focusPath === r.path;
        // tint deepens toward the accent for leaves; intermediate rows stay cool/neutral.
        const t = r.isLeaf ? 0.16 : 0.05 + r.depth * 0.015;
        return (
          <button
            key={r.path + r.depth}
            type="button"
            title={`${r.path} · ${formatBytes(r.bytes)}`}
            onClick={() => onFocus(active ? null : r.path)}
            className="absolute overflow-hidden rounded-[3px] border text-left"
            style={{
              left: r.x + 1,
              top: r.y + 1,
              width: Math.max(0, r.w - 2),
              height: r.h - 2,
              background: `rgba(61,220,132,${t})`,
              borderColor: active ? "var(--color-primary)" : "rgba(255,255,255,.05)",
            }}
          >
            {r.w > 44 && (
              <span className="block truncate px-1.5 text-[10px] leading-[22px] text-ink-soft">{r.name}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
