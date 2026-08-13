import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, FolderInput, Lock, Plus, ScanLine, Search, SearchX, X } from "lucide-react";
import { ageDays, formatAge, formatBytes, formatCount } from "@bridge/domain";
import {
  listSavedViews,
  runSavedView,
  saveCatalogRule,
  searchNativeIndex,
  type NativeSavedView,
} from "@bridge/nativeClient";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { CATEGORIES, CATEGORY_ORDER, categoryOf, type MediaKind } from "../../lib/categories";
import { Card, EmptyState } from "../ui/Card";
import { Button } from "../ui/Button";
import { Chip, Tag } from "../ui/Chip";
import { MoveDialog } from "../MoveDialog";
import { ViewHeader } from "./ViewHeader";

const SEARCH_LIMIT = 500;
const RENDER_CAP = 200;

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
    clearQuery,
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
  /** Bulk-select for the results list — local to this view, not the global store. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [rulePrompt, setRulePrompt] = useState<{ text: string; destination: string } | null>(null);
  const reqId = useRef(0);
  /** The last committed selection key — a change means clear old rows and show loading. */
  const lastSel = useRef("");
  /** Content signature of the last query the selection-clearing effect saw. */
  const lastQuerySig = useRef("");
  /** Paths that have actually moved so far in the open move dialog's session. */
  const movedPathsRef = useRef<string[]>([]);

  const togglePick = useCallback((path: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // A different query invalidates any in-progress bulk selection — the rows
  // it referred to are no longer the ones on screen. Compared by content, not
  // object identity: `runQuery` always hands back a fresh literal, so
  // re-clicking the active view chip or re-submitting the same search text
  // must not wipe a selection the visible rows haven't actually changed under.
  useEffect(() => {
    const sig = JSON.stringify(resultsQuery);
    if (sig === lastQuerySig.current) return;
    lastQuerySig.current = sig;
    setPicked(new Set());
  }, [resultsQuery]);

  useEffect(() => {
    void listSavedViews().then(setSavedViews).catch(() => setSavedViews([]));
  }, []);

  // Mirror the active search text (e.g. when the command spine routed here).
  useEffect(() => {
    if (resultsQuery?.kind === "search") setText(resultsQuery.text);
  }, [resultsQuery]);

  // Live search: typing runs the query after a short pause; an emptied box
  // drops the search so the view falls back to the largest-files preset.
  useEffect(() => {
    const t = text.trim();
    const current = resultsQuery?.kind === "search" ? resultsQuery.text : null;
    if (t === (current ?? "")) return; // already committed (incl. spine-routed mirrors)
    if (resultsQuery?.kind === "view" && t === "") return; // don't clobber a saved view
    const timer = window.setTimeout(() => {
      if (t) runQuery({ kind: "search", text: t });
      else clearQuery();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, resultsQuery, runQuery, clearQuery]);

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
    // A changed selection (a different view chip or category) clears the old
    // rows so the loading state shows at once — otherwise the previous chip's
    // results linger during the fetch and the switch looks like it didn't take.
    // Background refetches (same selection, new dataVersion) keep their rows to
    // avoid a flash while enrichment streams in.
    const sel = `${JSON.stringify(resultsQuery)}|${kindFilter ?? ""}`;
    if (lastSel.current !== sel) {
      setFetched([]);
      lastSel.current = sel;
    }
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

  // "All loaded", never "all matching": search_files has no OFFSET and returns
  // no total, so the frontend only ever holds the first SEARCH_LIMIT rows.
  const pickAllLoaded = useCallback(() => {
    setPicked(new Set(rows.map((r) => r.path)));
  }, [rows]);

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
            hint="Bird's Eye indexes names, sizes, types and ages on this machine. Nothing is uploaded."
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
                placeholder="Search files by name or path"
                spellCheck={false}
                className="mono w-full rounded-lg border border-line-input bg-field py-2 pr-8 pl-8 text-12 text-ink placeholder:text-dim focus:border-primary/60 focus:outline-none"
              />
              {text || resultsQuery ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  title="Clear search"
                  onClick={() => {
                    setText("");
                    clearQuery();
                  }}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-dim transition-colors hover:text-ink"
                >
                  <X size={13} strokeWidth={2} aria-hidden />
                </button>
              ) : null}
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
                  title={ontologyEnabled ? v.description : "Run the analysis to use the curated views"}
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
              title="This view needs the analysis"
              hint="Curated views read what Bird's Eye found about your folders. Run the analysis from Findings, or just search instead."
              className="be-rise be-d3"
            />
          ) : (
            <div className="be-rise be-d3 flex flex-col gap-2">
              {/* Count line — a capped search never claims to be the whole match set. */}
              <div className="flex items-baseline gap-1.5 text-11 text-faint">
                {resultsQuery?.kind === "search" && rows.length >= SEARCH_LIMIT ? (
                  <span className="mono font-semibold text-ink-soft">
                    showing first {SEARCH_LIMIT} matches
                  </span>
                ) : (
                  <>
                    <span className="mono font-semibold text-ink-soft">{formatCount(rows.length)}</span>
                    <span>files ·</span>
                  </>
                )}
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
                      ? "Some curated views only fill in once the analysis finishes, or once you confirm findings."
                      : "Try a shorter term, or clear the category filter."
                  }
                />
              ) : (
                <Card className="overflow-hidden">
                  {picked.size ? (
                    <div className="flex flex-none items-center gap-2 border-b border-line bg-inset px-3 py-2">
                      <span className="text-115 text-ink">{picked.size} selected</span>
                      <button
                        type="button"
                        onClick={pickAllLoaded}
                        className="text-115 text-primary-ink hover:underline"
                      >
                        Select all {rows.length} loaded
                      </button>
                      <button
                        type="button"
                        onClick={() => setPicked(new Set())}
                        className="text-115 text-faint hover:text-ink"
                      >
                        Clear
                      </button>
                      <span className="flex-1" />
                      <Button
                        variant="primary"
                        size="sm"
                        icon={FolderInput}
                        onClick={() => {
                          movedPathsRef.current = [];
                          setMoveOpen(true);
                        }}
                      >
                        Move to…
                      </Button>
                    </div>
                  ) : null}
                  {shown.map((r) => {
                    const cat = categoryOf(r.kind);
                    const Icon = cat.icon;
                    // Reset/lost mtimes (pre-1990) resolve to null — an unknown
                    // age. `dateLost` distinguishes that from a file that simply
                    // carries no timestamp. The age column below is the only age
                    // signal: a number, never a "Stale" badge.
                    const days = ageDays(r.modifiedAt, nowSec);
                    const dateLost = r.modifiedAt !== null && days === null;
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
                        <input
                          type="checkbox"
                          checked={picked.has(r.path)}
                          aria-label={`Select ${r.name}`}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => togglePick(r.path)}
                          className="flex-none"
                        />
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
                          </div>
                          <div className="mono truncate text-10 text-dim">{r.path}</div>
                        </div>
                        <span className="mono w-[72px] flex-none text-right text-12 text-muted">
                          {formatBytes(r.size)}
                        </span>
                        {showAge ? (
                          <span
                            className="mono w-20 flex-none text-right text-11 text-dim"
                            title={
                              days !== null
                                ? `${formatCount(days)} days`
                                : dateLost
                                  ? "Date unknown — this file's modified time was lost in transfer (reads as ~1980)"
                                  : undefined
                            }
                          >
                            {days !== null ? formatAge(days) : "—"}
                          </span>
                        ) : null}
                        <Button
                          size="sm"
                          variant={staged ? "subtle" : "ghost"}
                          icon={staged ? Check : Plus}
                          className="flex-none"
                          title={
                            staged
                              ? "Remove from the cleanup tray"
                              : "Add to the cleanup tray — Bird's Eye checks again before it removes anything"
                          }
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

      {moveOpen ? (
        <MoveDialog
          paths={[...picked]}
          onClose={() => setMoveOpen(false)}
          onMoved={(destination, movedPaths, allMoved) => {
            // Drop only the paths that actually moved — a partial failure
            // leaves the still-selected failures at their original location.
            movedPathsRef.current.push(...movedPaths);
            setPicked((prev) => {
              const next = new Set(prev);
              for (const p of movedPaths) next.delete(p);
              return next;
            });
            if (!allMoved) return;
            const moved = movedPathsRef.current;
            movedPathsRef.current = [];
            // Only offer the rule when it would actually fire: the backend
            // matcher tests the file's own name, never its containing path,
            // so a search that matched some files only via their folder path
            // (e.g. "Invoices" matching everything under a `\Invoices\`
            // folder) must not save a rule that can never apply to them.
            if (
              resultsQuery?.kind === "search" &&
              destination &&
              indexPath &&
              moved.length > 0 &&
              moved.every((p) => fileName(p).toLowerCase().includes(resultsQuery.text.toLowerCase()))
            ) {
              setRulePrompt({ text: resultsQuery.text, destination });
            }
          }}
        />
      ) : null}

      {rulePrompt ? (
        <div className="flex flex-none items-center gap-2 border-t border-line bg-inset px-3 py-2">
          <span className="text-115 text-dim">
            Always move files matching “{rulePrompt.text}” to {rulePrompt.destination}?
          </span>
          <Button
            onClick={() => {
              if (indexPath) {
                saveCatalogRule(indexPath, {
                  name: `Files matching “${rulePrompt.text}”`,
                  nameContains: rulePrompt.text,
                  destination: rulePrompt.destination,
                  source: "saved-after-move",
                }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
              }
              setRulePrompt(null);
            }}
          >
            Save as rule
          </Button>
          <button
            type="button"
            onClick={() => setRulePrompt(null)}
            className="text-115 text-faint hover:text-ink"
          >
            No thanks
          </button>
        </div>
      ) : null}
    </div>
  );
}
