import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  HardDrive,
  ListOrdered,
  RefreshCw,
  ScanLine,
  ScanSearch,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  deleteNativeIndex,
  fileLockHolders,
  retryScanIssues,
  revealInExplorer,
  scanIssues,
  setOntologyEnabled,
  type NativeIndexEntry,
  type NativeScanIssue,
} from "@bridge/nativeClient";
import { formatBytes, formatCount, lastSegment } from "@bridge/domain";
import { useWorkspace } from "../../state/workspaceStore";
import { useIndexData } from "../../state/indexData";
import { useScanController } from "../../state/scanController";
import { Button, IconButton } from "../ui/Button";
import { Card, EmptyState, Meter, SectionLabel } from "../ui/Card";
import { Tag } from "../ui/Chip";
import { ViewHeader } from "./ViewHeader";

/** "2 h ago" style relative time from a unix-seconds stamp. */
function relTime(ts: number | null): string {
  if (!ts) return "never scanned";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} yr ago`;
}

/**
 * Scan management as a first-class section: the running scan, the queue, and
 * every index you've built — scanning is how all the other views get their data.
 */
export function ScansView() {
  const { setOverlay, setIndexPath, setView, setScopePath } = useWorkspace();
  const { indexes, activeEntry, refreshIndexes } = useIndexData();
  const { enqueue, queue, dequeue, view, cancel } = useScanController();

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rescanningId, setRescanningId] = useState<string | null>(null);
  /** Index whose issue list is expanded, plus its lazily fetched rows. */
  const [issuesOpenId, setIssuesOpenId] = useState<string | null>(null);
  const [issueRows, setIssueRows] = useState<NativeScanIssue[]>([]);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  /** Lock diagnosis per issue path: undefined = unchecked, null = checking. */
  const [lockHolders, setLockHolders] = useState<Record<string, string[] | null>>({});

  const toggleIssues = (entry: NativeIndexEntry) => {
    if (issuesOpenId === entry.index_path) {
      setIssuesOpenId(null);
      return;
    }
    setIssuesOpenId(entry.index_path);
    setIssueRows([]);
    setLockHolders({});
    void scanIssues(entry.index_path)
      .then(setIssueRows)
      .catch(() => setIssueRows([]));
  };

  /** Re-walk failed folders + re-verify unhashed files — no full rescan. */
  const handleRetryIssues = async (entry: NativeIndexEntry) => {
    setRetryingId(entry.index_path);
    setError(null);
    try {
      await retryScanIssues(entry.index_path);
      await refreshIndexes(); // pick up the new issue counts
      setIssueRows(await scanIssues(entry.index_path));
      setLockHolders({});
    } catch (e) {
      setError(String(e));
    } finally {
      setRetryingId(null);
    }
  };

  const checkLock = (path: string) => {
    setLockHolders((prev) => ({ ...prev, [path]: null }));
    void fileLockHolders(path)
      .then((names) => setLockHolders((prev) => ({ ...prev, [path]: names })))
      .catch(() => setLockHolders((prev) => ({ ...prev, [path]: [] })));
  };

  const handleRescan = (entry: NativeIndexEntry) => {
    if (!entry.root_path) return;
    setRescanningId(entry.index_path);
    setError(null);
    try {
      // Runs now if idle, else lines up behind the running scan. Only follow it
      // to the progress sheet when it actually started. A plain rescan keeps
      // the index's intelligence setting as-is.
      if (enqueue(entry.root_path, entry.scan_strategy) === "started") setOverlay("scan");
    } catch (e) {
      setError(String(e));
    } finally {
      setRescanningId(null);
    }
  };

  /** Late opt-in for an index scanned without intelligence: flag it on, then run
   *  an incremental rescan whose enrichment phase classifies fresh data. */
  const [enablingId, setEnablingId] = useState<string | null>(null);
  const handleEnableIntelligence = async (entry: NativeIndexEntry) => {
    if (!entry.root_path) return;
    setEnablingId(entry.index_path);
    setError(null);
    try {
      await setOntologyEnabled(entry.index_path, true);
      await refreshIndexes();
      if (enqueue(entry.root_path, entry.scan_strategy, true) === "started") setOverlay("scan");
    } catch (e) {
      setError(String(e));
    } finally {
      setEnablingId(null);
    }
  };

  const handleDeleteClick = async (entry: NativeIndexEntry) => {
    if (confirmDeleteId !== entry.index_path) {
      setConfirmDeleteId(entry.index_path);
      setError(null);
      return;
    }
    setDeletingId(entry.index_path);
    setError(null);
    try {
      await deleteNativeIndex(entry.index_path);
      setConfirmDeleteId(null);
      await refreshIndexes();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeletingId(null);
    }
  };

  const running = view.status === "scanning";
  const showEmpty = indexes.length === 0 && !running && queue.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Scans"
        sub={`${indexes.length} ${indexes.length === 1 ? "index" : "indexes"} · ${running ? 1 : 0} running · ${queue.length} queued`}
        actions={
          <Button variant="primary" size="sm" icon={ScanLine} onClick={() => setOverlay("scan")}>
            New scan
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[980px] flex-col gap-5 p-4">
          {error ? (
            <div className="flex items-center gap-2 rounded-[9px] border border-danger/40 px-3 py-2 text-11 text-danger">
              <AlertTriangle size={13} strokeWidth={2} aria-hidden className="flex-none" />
              <span className="min-w-0 truncate" title={error}>
                {error}
              </span>
            </div>
          ) : null}

          {running ? (
            <section className="be-rise">
              <SectionLabel className="mb-2">Running now</SectionLabel>
              <div className="flex items-center gap-3 rounded-xl border border-primary-edge bg-primary-wash px-4 py-3">
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 flex-none rounded-full bg-primary"
                  style={{ animation: "bePulse 1.6s ease infinite" }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <button
                      type="button"
                      onClick={() => setOverlay("scan")}
                      title={view.currentPath || "View progress"}
                      className="min-w-0 truncate text-125 text-ink transition-colors hover:text-primary-ink"
                    >
                      {view.message || "Scanning…"}
                    </button>
                    <span className="mono ml-auto flex-none text-11 text-dim">
                      {formatCount(view.files)} files · {formatBytes(view.bytes)}
                      {view.pct >= 0 ? ` · ${Math.round(view.pct)}%` : ""}
                    </span>
                  </div>
                  {view.pct >= 0 ? (
                    <Meter fraction={view.pct / 100} height={5} className="mt-2" />
                  ) : (
                    <div style={{ animation: "bePulse 1.6s ease infinite" }}>
                      <Meter fraction={1} height={5} className="mt-2" />
                    </div>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => setOverlay("scan")}>
                  Details
                </Button>
                <IconButton icon={X} label="Cancel scan" size={14} onClick={() => void cancel()} />
              </div>
            </section>
          ) : null}

          {view.status === "failed" && view.message ? (
            <div className="flex items-center gap-2 rounded-[9px] border border-danger/40 px-3 py-2 text-11 text-danger">
              <AlertTriangle size={13} strokeWidth={2} aria-hidden className="flex-none" />
              <span className="min-w-0 truncate" title={view.message}>
                {view.message}
              </span>
            </div>
          ) : null}

          {queue.length > 0 ? (
            <section className="be-rise be-d1">
              <div className="mb-2 flex items-baseline gap-2">
                <SectionLabel>Queued</SectionLabel>
                <span className="text-105 text-dim">runs after the active scan</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {queue.map((q, i) => (
                  <div
                    key={`${q.root}:${i}`}
                    className="flex items-center gap-2.5 rounded-[9px] border border-line-modal bg-inset px-3 py-2"
                  >
                    <ListOrdered size={13} className="flex-none text-label" aria-hidden />
                    <span className="mono flex-none text-11 text-dim">{i + 1}</span>
                    <span className="min-w-0 truncate text-12 text-ink-soft" title={q.root}>
                      {q.root}
                    </span>
                    <Tag>{q.strategy}</Tag>
                    <IconButton
                      icon={X}
                      label="Remove from queue"
                      size={13}
                      className="ml-auto"
                      onClick={() => dequeue(i)}
                    />
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {indexes.length > 0 ? (
            <section className="be-rise be-d2">
              <div className="mb-2 flex items-baseline gap-2">
                <SectionLabel>Indexes</SectionLabel>
                <span className="text-105 text-dim">
                  open switches the workspace — deleting removes only the local catalog, never your
                  files
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                {indexes.map((entry) => {
                  const active =
                    activeEntry !== null && activeEntry.index_path === entry.index_path;
                  const isDeleting = deletingId === entry.index_path;
                  const isRescanning = rescanningId === entry.index_path;
                  const confirmingDelete = confirmDeleteId === entry.index_path;
                  const rootName = entry.root_path ? lastSegment(entry.root_path) : "(unknown root)";
                  const issueCount = entry.walk_issues + entry.hash_issues;
                  const issuesOpen = issuesOpenId === entry.index_path;

                  return (
                    <Card
                      key={entry.index_path}
                      className="px-3 py-2.5"
                      style={active ? { borderColor: "var(--color-primary-edge)" } : undefined}
                    >
                      <div className="flex items-center gap-2.5">
                        <span
                          className={`flex h-9 w-9 flex-none items-center justify-center rounded-lg ${
                            active ? "bg-primary-dim text-primary" : "bg-raised text-faint"
                          }`}
                        >
                          <HardDrive size={16} strokeWidth={2} aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-125 font-medium text-ink" title={rootName}>
                              {rootName}
                            </span>
                            <Tag>{entry.scan_strategy}</Tag>
                            {entry.intelligence ? (
                              <span title="Intelligence is on — folders are classified during scans">
                                <Tag tone="green">Intelligence</Tag>
                              </span>
                            ) : entry.root_path ? (
                              <button
                                type="button"
                                disabled={enablingId === entry.index_path}
                                title="Classifies every folder on-device (reads file contents, nothing leaves this machine). Runs an incremental rescan so verdicts reflect current data."
                                onClick={() => void handleEnableIntelligence(entry)}
                                className="flex items-center gap-1 rounded-full border border-primary-edge px-2 py-0.5 text-9 font-semibold tracking-[0.08em] text-primary-ink uppercase transition-[filter] hover:brightness-125 disabled:opacity-50"
                              >
                                <Sparkles size={9} aria-hidden />
                                {enablingId === entry.index_path ? "Enabling…" : "Enable intelligence"}
                              </button>
                            ) : null}
                            {active ? <Tag tone="green">Active</Tag> : null}
                          </div>
                          {entry.root_path ? (
                            <div
                              className="mono mt-0.5 truncate text-105 text-faint"
                              title={entry.root_path}
                            >
                              {entry.root_path}
                            </div>
                          ) : null}
                          <div className="mono mt-0.5 text-105 text-dim">
                            {formatBytes(entry.bytes_scanned)} ·{" "}
                            {formatCount(entry.files_scanned)} files · {relTime(entry.last_scanned_at)}
                          </div>
                        </div>

                        <div className="flex flex-none items-center gap-1">
                          {!active ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setIndexPath(entry.index_path);
                                setScopePath([]);
                                setView("overview");
                              }}
                            >
                              Open
                            </Button>
                          ) : null}
                          {entry.root_path ? (
                            <IconButton
                              icon={RefreshCw}
                              label="Re-scan"
                              size={14}
                              disabled={isRescanning}
                              onClick={() => handleRescan(entry)}
                            />
                          ) : null}
                          {confirmingDelete ? (
                            <Button
                              variant="danger"
                              size="sm"
                              icon={Trash2}
                              disabled={isDeleting}
                              style={{
                                color: "var(--color-danger)",
                                borderColor: "color-mix(in srgb, var(--color-danger) 50%, transparent)",
                              }}
                              onClick={() => void handleDeleteClick(entry)}
                            >
                              {isDeleting ? "Deleting…" : "Confirm"}
                            </Button>
                          ) : (
                            <IconButton
                              icon={Trash2}
                              label="Delete index"
                              size={14}
                              onClick={() => void handleDeleteClick(entry)}
                            />
                          )}
                        </div>
                      </div>

                      {issueCount > 0 ? (
                        <div className="mt-2 border-t border-line-soft pt-2">
                          <button
                            type="button"
                            onClick={() => toggleIssues(entry)}
                            className="flex w-full items-center gap-1.5 text-left text-11 text-warn transition-colors hover:brightness-125"
                            aria-expanded={issuesOpen}
                          >
                            {issuesOpen ? (
                              <ChevronDown size={12} aria-hidden />
                            ) : (
                              <ChevronRight size={12} aria-hidden />
                            )}
                            <AlertTriangle size={12} aria-hidden />
                            <span>
                              {entry.walk_issues > 0 ? (
                                <>
                                  <span className="mono font-semibold">{formatCount(entry.walk_issues)}</span>{" "}
                                  item{entry.walk_issues === 1 ? "" : "s"} couldn't be read
                                </>
                              ) : null}
                              {entry.walk_issues > 0 && entry.hash_issues > 0 ? " · " : null}
                              {entry.hash_issues > 0 ? (
                                <>
                                  <span className="mono font-semibold">{formatCount(entry.hash_issues)}</span>{" "}
                                  file{entry.hash_issues === 1 ? "" : "s"} couldn't be verified for duplicates
                                </>
                              ) : null}
                            </span>
                          </button>
                          {issuesOpen ? (
                            <div className="mt-1.5 rounded-lg border border-line-soft bg-inset">
                              <div className="flex items-center justify-between gap-2 border-b border-line-soft px-2.5 py-1.5">
                                <span className="text-10 text-label">
                                  Close the apps holding these files (or make cloud files available
                                  offline), then retry — only the failed items are re-checked.
                                </span>
                                <Button
                                  size="sm"
                                  variant="subtle"
                                  icon={RefreshCw}
                                  disabled={retryingId === entry.index_path}
                                  onClick={() => void handleRetryIssues(entry)}
                                >
                                  {retryingId === entry.index_path ? "Retrying…" : "Retry all"}
                                </Button>
                              </div>
                              <div className="max-h-56 overflow-y-auto">
                                {issueRows.length === 0 ? (
                                  <div className="px-2.5 py-2 text-10 text-label italic">Loading…</div>
                                ) : (
                                  issueRows.map((issue, i) => {
                                    const holders = lockHolders[issue.path];
                                    return (
                                      <div
                                        key={`${issue.path}:${i}`}
                                        className="flex items-center gap-2 border-b border-line-soft px-2.5 py-1.5 text-10 last:border-b-0"
                                      >
                                        <Tag tone={issue.phase === "walk" ? "amber" : "neutral"}>
                                          {issue.phase === "walk" ? "unreadable" : "unverified"}
                                        </Tag>
                                        <div className="min-w-0 flex-1">
                                          <div className="mono truncate text-ink-soft" title={issue.path}>
                                            {issue.path}
                                          </div>
                                          <div className="truncate text-dim" title={issue.message}>
                                            {holders === null ? (
                                              "checking who's using it…"
                                            ) : holders !== undefined ? (
                                              holders.length ? (
                                                <span className="text-warn">
                                                  in use by {holders.join(", ")} — close it, then retry
                                                </span>
                                              ) : (
                                                <span className="text-primary-ink">
                                                  nothing is holding it now — hit Retry all
                                                </span>
                                              )
                                            ) : (
                                              issue.message.replace(/\.? \(os error \d+\)$/, "")
                                            )}
                                          </div>
                                        </div>
                                        <IconButton
                                          icon={ScanSearch}
                                          label="Check what's using this file"
                                          size={13}
                                          onClick={() => checkLock(issue.path)}
                                        />
                                        <IconButton
                                          icon={FolderOpen}
                                          label="Reveal in Explorer"
                                          size={13}
                                          onClick={() => void revealInExplorer(issue.path).catch(() => {})}
                                        />
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </Card>
                  );
                })}
              </div>
            </section>
          ) : null}

          {showEmpty ? (
            <EmptyState
              icon={ScanLine}
              title="No scans yet"
              hint="Index a folder to see sizes, types, ages and duplicates — everything stays on this machine."
              action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
              className="be-rise"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
