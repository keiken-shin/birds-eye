import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Lock, Plus, ScanLine, Search, SearchX } from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import {
  listSavedViews,
  runSavedView,
  searchNativeIndex,
  type NativeSavedView,
} from "@bridge/nativeClient";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { CATEGORIES, CATEGORY_ORDER, categoryOf, type MediaKind } from "../../lib/categories";
import { Card, EmptyState } from "../ui/Card";
import { Button } from "../ui/Button";
import { Chip, Tag } from "../ui/Chip";
import { ViewHeader } from "./ViewHeader";

const SEARCH_LIMIT = 500;
const RENDER_CAP = 200;
const STALE_DAYS = 180;
const DAY_S = 86400;

type SortKey = "size" | "newest" | "oldest";
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "size", label: "Size" },
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
];

/** Unified row over the three sources (preset / search / saved view). */
type FileRow = {
  path: string;
  name: string;
  size: number;
  extension: string | null;
  /** media_kind when known; null for saved-view rows (backend returns none). */
  kind: MediaKind | null;
  modifiedAt: number | null;
};

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

/**
 * Files view — ranked file results over one query. Free text routes to
 * `search_files`; curated saved views route to `run_saved_view` (gated on
 * intelligence); with no query it shows the "Largest files" preset straight
 * from the overview. The query is the shared `resultsQuery` global, so the
 * command spine and this view's own controls drive the same list.
 */
export function FilesView() {
  const {
    indexPath,
    ontologyEnabled,
    resultsQuery,
    runQuery,
    select,
    selected,
    isStaged,
    toggleStaged,
    setOverlay,
  } = useWorkspace();
  const { status, overview, dataVersion } = useIndexData();

  const [savedViews, setSavedViews] = useState<NativeSavedView[]>([]);
  const [fetched, setFetched] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(resultsQuery?.kind === "search" ? resultsQuery.text : "");
  const [kindFilter, setKindFilter] = useState<MediaKind | null>(null);
  const [sort, setSort] = useState<SortKey>("size");
  const reqId = useRef(0);

  useEffect(() => {
    void listSavedViews().then(setSavedViews).catch(() => setSavedViews([]));
  }, []);

  // Mirror the active search text (e.g. when the command spine routed here).
  useEffect(() => {
    if (resultsQuery?.kind === "search") setText(resultsQuery.text);
  }, [resultsQuery]);

  const viewNeedsIntel = resultsQuery?.kind === "view" && !ontologyEnabled;

  // Fetch when a query is active. Preset rows come from `overview` directly.
  useEffect(() => {
    if (!indexPath || !resultsQuery || viewNeedsIntel) {
      setFetched([]);
      setError(null);
      setLoading(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        let out: FileRow[];
        if (resultsQuery.kind === "search") {
          const res = await searchNativeIndex(
            indexPath,
            resultsQuery.text,
            SEARCH_LIMIT,
            kindFilter ? { kinds: [kindFilter] } : undefined
          );
          out = res.map((r) => ({
            path: r.path,
            name: r.name,
            size: r.size,
            extension: r.extension,
            kind: categoryOf(r.media_kind).kind,
            modifiedAt: r.modified_at,
          }));
        } else {
          const res = await runSavedView(indexPath, resultsQuery.viewId);
          out = res.map((r) => ({
            path: r.path,
            name: fileName(r.path),
            size: r.size,
            extension: null,
            kind: null,
            modifiedAt: null,
          }));
        }
        if (id !== reqId.current) return;
        setFetched(out);
      } catch (e) {
        if (id === reqId.current) setError(String(e));
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    })();
    // dataVersion: re-run after a fresh scan/enrichment so results reflect new facts.
  }, [indexPath, resultsQuery, kindFilter, viewNeedsIntel, dataVersion]);

  // Default preset: largest files straight from the overview (already size-ranked).
  const presetRows = useMemo<FileRow[]>(
    () =>
      (overview?.files ?? []).map((f) => ({
        path: f.path,
        name: fileName(f.path),
        size: f.size,
        extension: f.extension,
        kind: categoryOf(f.media_kind).kind,
        modifiedAt: f.modified_at,
      })),
    [overview]
  );

  const rows = useMemo(() => {
    const base = resultsQuery ? fetched : presetRows;
    // Client-side kind filter where kind is known (search already filtered server-side;
    // saved-view rows carry no kind, so they pass through untouched).
    const filtered = kindFilter ? base.filter((r) => r.kind === null || r.kind === kindFilter) : base;
    const sorted = [...filtered];
    if (sort === "size") {
      sorted.sort((a, b) => b.size - a.size);
    } else {
      const dir = sort === "newest" ? -1 : 1;
      sorted.sort((a, b) => {
        if (a.modifiedAt === null && b.modifiedAt === null) return b.size - a.size;
        if (a.modifiedAt === null) return 1; // unknown dates sink to the bottom
        if (b.modifiedAt === null) return -1;
        return dir * (a.modifiedAt - b.modifiedAt);
      });
    }
    return sorted;
  }, [resultsQuery, fetched, presetRows, kindFilter, sort]);

  const totalBytes = useMemo(() => rows.reduce((s, r) => s + Math.max(0, r.size), 0), [rows]);
  const shown = rows.slice(0, RENDER_CAP);
  const overflow = rows.length - shown.length;
  const showAge = resultsQuery?.kind !== "view"; // saved-view rows have no modified time
  const nowSec = Math.floor(Date.now() / 1000);

  const submitSearch = () => {
    const t = text.trim();
    if (t) runQuery({ kind: "search", text: t });
  };

  if (status === "no-index") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Files" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={ScanLine}
            title="Scan a folder to search your files"
            hint="Bird's Eye indexes names, sizes, types and ages locally — nothing leaves this machine."
            action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
          />
        </div>
      </div>
    );
  }

  const sub =
    resultsQuery === null ? (
      "largest files"
    ) : resultsQuery.kind === "search" ? (
      <span className="mono">“{resultsQuery.text}”</span>
    ) : (
      resultsQuery.viewName
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader title="Files" sub={sub} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-4 p-4">
          {/* Search + sort */}
          <div className="be-rise flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                size={13}
                strokeWidth={2}
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dim"
              />
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitSearch()}
                placeholder="Search files by name or path — Enter to run"
                spellCheck={false}
                className="mono w-full rounded-lg border border-line-input bg-field py-2 pr-3 pl-8 text-12 text-ink placeholder:text-dim focus:border-primary/60 focus:outline-none"
              />
            </div>
            <span className="flex flex-none gap-[2px] rounded-lg border border-line-input bg-field p-[2px] text-10">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSort(s.key)}
                  className={`rounded-md px-2 py-1 font-medium tracking-wide uppercase transition-colors ${
                    sort === s.key ? "bg-primary text-on-primary" : "text-faint hover:text-ink"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </span>
          </div>

          {/* Category filter */}
          <div className="be-rise be-d1 flex flex-wrap items-center gap-1.5">
            <Chip active={kindFilter === null} onClick={() => setKindFilter(null)}>
              All
            </Chip>
            {CATEGORY_ORDER.map((k) => (
              <Chip
                key={k}
                active={kindFilter === k}
                dot={CATEGORIES[k].color}
                onClick={() => setKindFilter((prev) => (prev === k ? null : k))}
              >
                {CATEGORIES[k].label}
              </Chip>
            ))}
          </div>

          {/* Curated saved views */}
          {savedViews.length > 0 ? (
            <div className="be-rise be-d2 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-10 font-semibold tracking-[0.12em] text-label uppercase">
                Views
              </span>
              {savedViews.map((v) => (
                <Chip
                  key={v.id}
                  active={resultsQuery?.kind === "view" && resultsQuery.viewId === v.id}
                  icon={v.protective ? Lock : undefined}
                  disabled={!ontologyEnabled}
                  title={ontologyEnabled ? v.description : "Enable intelligence to use curated views"}
                  onClick={() => runQuery({ kind: "view", viewId: v.id, viewName: v.name })}
                  className="disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {v.name}
                </Chip>
              ))}
            </div>
          ) : null}

          {error ? (
            <div className="be-rise be-d3 rounded-lg border border-danger/30 px-3 py-2 text-11 text-danger">
              {error}
            </div>
          ) : null}

          {viewNeedsIntel ? (
            <EmptyState
              icon={Lock}
              title="This curated view needs intelligence"
              hint="Saved views read the roles and relationships found during enrichment. Enable intelligence on the Board, or run a plain search instead."
              className="be-rise be-d3"
            />
          ) : (
            <div className="be-rise be-d3 flex flex-col gap-2">
              {/* Count line */}
              <div className="flex items-baseline gap-1.5 text-11 text-faint">
                <span className="mono font-semibold text-ink-soft">{formatCount(rows.length)}</span>
                <span>files ·</span>
                <span className="mono font-semibold text-ink-soft">{formatBytes(totalBytes)}</span>
                <span>total</span>
              </div>

              {loading && rows.length === 0 ? (
                <Card className="p-8 text-center">
                  <span className="text-12 text-label" style={{ animation: "bePulse 1.6s ease infinite" }}>
                    Loading results…
                  </span>
                </Card>
              ) : rows.length === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="No files match"
                  hint={
                    resultsQuery?.kind === "view"
                      ? "Some curated views only fill in after enrichment finishes or findings are confirmed on the Board."
                      : "Try a shorter term, or clear the category filter."
                  }
                />
              ) : (
                <Card className="overflow-hidden">
                  {shown.map((r) => {
                    const cat = categoryOf(r.kind);
                    const Icon = cat.icon;
                    const days = r.modifiedAt !== null ? Math.max(0, Math.floor((nowSec - r.modifiedAt) / DAY_S)) : null;
                    const stale = days !== null && days > STALE_DAYS;
                    const staged = isStaged(r.path);
                    const sel = selected?.path === r.path;
                    return (
                      <div
                        key={r.path}
                        onClick={() => select({ kind: "file", path: r.path, name: r.name, bytes: r.size })}
                        className={`flex cursor-pointer items-center gap-3 border-b border-line-soft px-3 py-2 transition-colors last:border-b-0 ${
                          sel
                            ? "bg-primary-wash shadow-[inset_2px_0_0_var(--color-primary)]"
                            : "hover:bg-raised/50"
                        }`}
                      >
                        <span
                          className="flex h-8 w-8 flex-none items-center justify-center rounded-lg"
                          style={{
                            background: `color-mix(in srgb, ${cat.color} 13%, transparent)`,
                            color: cat.color,
                          }}
                        >
                          <Icon size={15} strokeWidth={2} aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-12 font-medium text-ink-soft">{r.name}</span>
                            {r.extension ? <Tag>{r.extension}</Tag> : null}
                            {stale ? <Tag tone="amber">Stale</Tag> : null}
                          </div>
                          <div className="mono truncate text-10 text-dim">{r.path}</div>
                        </div>
                        <span className="mono w-[72px] flex-none text-right text-12 text-muted">
                          {formatBytes(r.size)}
                        </span>
                        {showAge ? (
                          <span className="mono w-16 flex-none text-right text-11 text-dim">
                            {days !== null ? `${formatCount(days)}d ago` : "—"}
                          </span>
                        ) : null}
                        <Button
                          size="sm"
                          variant={staged ? "subtle" : "ghost"}
                          icon={staged ? Check : Plus}
                          className="flex-none"
                          title={staged ? "Remove from cleanup tray" : "Stage for cleanup (re-verified before removal)"}
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
                        >
                          {staged ? "Staged" : "Stage"}
                        </Button>
                      </div>
                    );
                  })}
                  {overflow > 0 ? (
                    <div className="border-t border-line-soft px-3 py-2 text-center text-11 text-faint">
                      <span className="mono">+{formatCount(overflow)}</span> more — refine your search
                    </div>
                  ) : null}
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
