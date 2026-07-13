import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, CopyCheck, FolderInput, ScanLine, TriangleAlert } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import {
  allowPreviewRoot,
  queryNativeDuplicateFiles,
  type NativeDuplicateFile,
} from "@bridge/nativeClient";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { baseName } from "../../lib/discoveries";
import { FilePreview } from "../FilePreview";
import { MoveDialog } from "../MoveDialog";
import { Card, EmptyState, Meter, SectionLabel } from "../ui/Card";
import { Button, IconButton } from "../ui/Button";
import { Tag } from "../ui/Chip";
import { ViewHeader } from "./ViewHeader";

const GROUP_LIMIT = 100;
const FILES_PER_GROUP = 50;

const HASH_TAG: Record<number, { label: string; tone: "green" | "neutral" }> = {
  4: { label: "VERIFIED", tone: "green" },
  2: { label: "SAMPLED", tone: "neutral" },
  0: { label: "SIZE MATCH", tone: "neutral" },
};

function ConfidenceTag({ confidence }: { confidence: number }) {
  if (confidence >= 0.99) return <Tag tone="green">VERIFIED</Tag>;
  if (confidence >= 0.8) return <Tag>SAMPLED</Tag>;
  return <Tag>SIZE MATCH</Tag>;
}

function modifiedAgo(ts: number | null) {
  if (!ts) return "modified —";
  const days = Math.max(0, Math.floor((Date.now() - ts * 1000) / 86_400_000));
  return `modified ${days}d ago`;
}

/** Newest copy = latest modified time; unknown mtimes sort oldest. */
function newestOf(files: NativeDuplicateFile[]): NativeDuplicateFile | null {
  if (!files.length) return null;
  return files.reduce((best, f) => ((f.modified_at ?? -1) > (best.modified_at ?? -1) ? f : best), files[0]);
}

/**
 * Duplicates workbench as a full stage view: group list on the left (waste-ranked),
 * copy cards with media previews on the right. Every action stages to the Cleanup
 * Tray — nothing here deletes directly.
 */
export function DuplicatesView() {
  const { status, overview, dataVersion, activeEntry } = useIndexData();
  const { indexPath, toggleStaged, isStaged, select, setOverlay, setView } = useWorkspace();
  const unverified = activeEntry?.hash_issues ?? 0;

  // Duplicate detection silently excludes files it couldn't hash — say so.
  const unverifiedNote =
    unverified > 0 ? (
      <button
        type="button"
        onClick={() => setView("scans")}
        className="flex items-center gap-1.5 border-b border-line-soft px-4 py-1.5 text-left text-11 text-warn transition-[filter] hover:brightness-125"
        title="Open Scans for the file-by-file list"
      >
        <TriangleAlert size={12} className="flex-none" aria-hidden />
        <span>
          <span className="mono font-semibold">{unverified}</span> file{unverified === 1 ? "" : "s"} couldn't
          be read for content verification (locked, permission denied or offline) and are not part of these
          groups — details in Scans →
        </span>
      </button>
    ) : null;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [movePaths, setMovePaths] = useState<string[] | null>(null);
  const [files, setFiles] = useState<NativeDuplicateFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [stagingAll, setStagingAll] = useState(false);
  const reqId = useRef(0);

  const groups = useMemo(
    () =>
      (overview?.duplicate_groups ?? [])
        .slice()
        .sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes)
        .slice(0, GROUP_LIMIT),
    [overview]
  );

  const totalWaste = useMemo(() => groups.reduce((s, g) => s + g.reclaimable_bytes, 0), [groups]);
  const maxWaste = groups[0]?.reclaimable_bytes ?? 0;
  const selectedGroup = groups.find((g) => g.id === selectedId) ?? null;

  // Let the asset protocol serve this scan root so previews can load (no-op in dev).
  useEffect(() => {
    if (!indexPath) return;
    allowPreviewRoot(indexPath).catch(() => {});
  }, [indexPath]);

  // Auto-select the first (biggest-waste) group; re-select if the current one vanished.
  useEffect(() => {
    if (groups.length && !groups.some((g) => g.id === selectedId)) setSelectedId(groups[0].id);
  }, [groups, selectedId]);

  // Fetch the selected group's copies; a request id guards against stale async results.
  // dataVersion re-runs the fetch after index changes (e.g. a copy moved elsewhere).
  useEffect(() => {
    if (selectedId === null || !indexPath) return;
    const id = ++reqId.current;
    setFiles(null);
    setFilesError(null);
    queryNativeDuplicateFiles(indexPath, selectedId, FILES_PER_GROUP)
      .then((f) => {
        if (id === reqId.current) setFiles(f);
      })
      .catch((e) => {
        if (id === reqId.current) setFilesError(String(e));
      });
  }, [selectedId, indexPath, dataVersion]);

  const newestPath = useMemo(() => newestOf(files ?? [])?.path ?? null, [files]);

  const stageCopy = (f: NativeDuplicateFile) =>
    toggleStaged({
      path: f.path,
      name: baseName(f.path),
      bytes: f.size,
      reason: "duplicate copy",
      verdict: "review",
      kind: "file",
    });

  /** Keep this copy: stage every other listed copy (and release this one if staged). */
  const keepCopy = (keep: NativeDuplicateFile) => {
    if (!files) return;
    if (isStaged(keep.path)) stageCopy(keep); // toggling a staged item unstages it
    for (const f of files) {
      if (f.path !== keep.path && !isStaged(f.path)) stageCopy(f);
    }
  };

  /** For every group: fetch its copies, keep the newest, stage the rest. */
  const stageAllKeepNewest = async () => {
    if (!indexPath || stagingAll) return;
    setStagingAll(true);
    try {
      const seen = new Set<string>(); // isStaged is a click-time snapshot; track our own adds
      for (const g of groups) {
        const list = await queryNativeDuplicateFiles(indexPath, g.id, FILES_PER_GROUP).catch(
          () => [] as NativeDuplicateFile[]
        );
        if (list.length < 2) continue;
        const newest = newestOf(list);
        for (const f of list) {
          if (f.path === newest?.path || seen.has(f.path) || isStaged(f.path)) continue;
          seen.add(f.path);
          stageCopy(f);
        }
      }
    } finally {
      setStagingAll(false);
    }
  };

  if (status === "no-index") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Duplicates" />
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={ScanLine}
            title="Scan a folder to find duplicates"
            hint="Bird's Eye hashes same-size files during smart scans and groups exact copies — everything stays on this machine."
            action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
          />
        </div>
      </div>
    );
  }

  if (!groups.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Duplicates" sub="0 groups" />
        {unverifiedNote}
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={Copy}
            title="No duplicates found"
            hint="Duplicates are detected during smart scans — metadata-only scans skip content hashing."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Duplicates"
        sub={
          <span>
            {groups.length} groups ·{" "}
            <span className="mono font-semibold text-danger">{formatBytes(totalWaste)}</span>{" "}
            recoverable
          </span>
        }
        actions={
          <Button
            variant="subtle"
            size="sm"
            icon={CopyCheck}
            disabled={stagingAll}
            onClick={() => void stageAllKeepNewest()}
          >
            {stagingAll ? "Staging…" : "Stage all (keep newest)"}
          </Button>
        }
      />
      {unverifiedNote}

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full">
          {/* Group list */}
          <div className="be-rise flex w-[320px] flex-none flex-col border-r border-line-soft">
            <SectionLabel className="px-4 pt-3 pb-1.5">
              Groups <span className="mono normal-case tracking-normal text-dim">· by waste</span>
            </SectionLabel>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {groups.map((g) => {
                const active = g.id === selectedId;
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => setSelectedId(g.id)}
                    className={`mt-1 w-full rounded-[9px] border px-3 py-2.5 text-left transition-colors ${
                      active
                        ? "border-primary-edge bg-primary-wash"
                        : "border-transparent hover:border-line hover:bg-inset"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`mono text-12 font-semibold ${active ? "text-ink" : "text-ink-soft"}`}>
                        {g.file_count} × {formatBytes(g.size)}
                      </span>
                      <ConfidenceTag confidence={g.confidence} />
                    </div>
                    <div className="mt-2 flex items-center gap-2.5">
                      <Meter
                        fraction={maxWaste ? g.reclaimable_bytes / maxWaste : 0}
                        color="var(--color-danger)"
                        height={4}
                        className="flex-1"
                      />
                      <span className="mono flex-none text-10 text-danger">
                        {formatBytes(g.reclaimable_bytes)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Copy detail */}
          <div className="be-rise be-d1 flex min-w-0 flex-1 flex-col">
            {selectedGroup ? (
              <div className="flex flex-none items-baseline gap-3 border-b border-line-soft px-4 py-2.5">
                <span className="text-12 text-muted">
                  Group <span className="mono text-ink-soft">#{selectedGroup.id}</span> ·{" "}
                  {selectedGroup.file_count} identical copies ·{" "}
                  <span className="mono text-ink-soft">{formatBytes(selectedGroup.size)}</span> each
                </span>
                <span className="ml-auto text-11 text-faint">
                  free{" "}
                  <span className="mono font-semibold text-primary-ink">
                    {formatBytes(selectedGroup.reclaimable_bytes)}
                  </span>{" "}
                  by keeping one
                </span>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {filesError ? (
                <div className="rounded-lg border border-danger/40 bg-inset px-3 py-2 text-11 text-danger">
                  {filesError}
                </div>
              ) : !files ? (
                <div className="flex h-full items-center justify-center text-12 text-label">
                  Loading copies…
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {files.map((f) => {
                    const name = baseName(f.path);
                    const staged = isStaged(f.path);
                    const hash = HASH_TAG[f.hash_state] ?? HASH_TAG[0];
                    return (
                      <Card
                        key={f.path}
                        onClick={() => select({ kind: "file", path: f.path, name, bytes: f.size })}
                        className={`flex cursor-pointer flex-col p-3 transition-colors ${
                          staged ? "border-primary-edge" : "hover:border-line-strong"
                        }`}
                      >
                        <FilePreview path={f.path} />
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-125 font-semibold text-ink">
                            {name}
                          </span>
                          {f.path === newestPath ? <Tag tone="blue">NEWEST</Tag> : null}
                          <Tag tone={hash.tone}>{hash.label}</Tag>
                        </div>
                        <div className="mono mt-1 break-all text-10 leading-relaxed text-dim">
                          {f.path}
                        </div>
                        <div className="mono mt-1.5 flex items-center gap-3 text-10 text-muted">
                          <span>{formatBytes(f.size)}</span>
                          <span className="text-faint">{modifiedAgo(f.modified_at)}</span>
                        </div>
                        <div className="mt-auto flex gap-2 pt-3">
                          <Button
                            variant="primary"
                            size="sm"
                            className="min-w-0 flex-1 whitespace-nowrap"
                            title="Keep this copy — stage the others for cleanup"
                            onClick={(e) => {
                              e.stopPropagation();
                              keepCopy(f);
                            }}
                          >
                            Keep this
                          </Button>
                          <Button
                            variant={staged ? "subtle" : "ghost"}
                            size="sm"
                            icon={staged ? Check : undefined}
                            onClick={(e) => {
                              e.stopPropagation();
                              stageCopy(f);
                            }}
                          >
                            {staged ? "Staged" : "Stage"}
                          </Button>
                          <IconButton
                            icon={FolderInput}
                            label="Move to folder…"
                            className="flex-none self-center"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMovePaths([f.path]);
                            }}
                          />
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {movePaths ? (
        <MoveDialog
          paths={movePaths}
          onClose={() => setMovePaths(null)}
          // The dialog's refresh bumps dataVersion, which refetches this group's copies.
          onMoved={() => {}}
        />
      ) : null}
    </div>
  );
}
