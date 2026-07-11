import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Anchor,
  Check,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderInput,
  Lock,
  MousePointerClick,
  Network,
  PanelRightClose,
  Scale,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import {
  REASON_LABELS,
  isNativeRuntime,
  revealInExplorer,
  type NativeTreemapLensFolder,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { canStage, explainFolder, verdictForFolder } from "../lib/verdict";
import { categoryOf } from "../lib/categories";
import { Card, EmptyState, SectionLabel } from "./ui/Card";
import { Button, IconButton } from "./ui/Button";
import { useSidePanel } from "./ui/SidePanel";
import { Kbd, Tag } from "./ui/Chip";
import { CategoryBar, type Segment } from "./ui/charts";
import { EnableIntelligenceCard } from "./EnableIntelligenceCard";
import { FilePreview } from "./FilePreview";
import { MoveDialog } from "./MoveDialog";
import type { Verdict } from "../state/types";

/** Verdict presentation on the design tokens — icon, label, token classes. */
const VERDICT_UI: Record<Verdict, { icon: LucideIcon; label: string; cls: string }> = {
  safe: { icon: ShieldCheck, label: "Safe to remove", cls: "bg-safe-bg border-safe-bd text-safe-tx" },
  review: { icon: Scale, label: "Review recommended", cls: "bg-review-bg border-review-bd text-review-tx" },
  protected: { icon: Lock, label: "Protected", cls: "bg-protected-bg border-protected-bd text-protected-tx" },
  keep: { icon: Anchor, label: "Keep — in use", cls: "bg-keep-bg border-keep-bd text-keep-tx" },
};

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="p-2.5">
      <div className="text-9 tracking-[0.08em] text-label uppercase">{label}</div>
      <div className="mono mt-1 text-135 font-semibold text-ink">{value}</div>
    </Card>
  );
}

function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function Inspector() {
  const { tree, overview, lensByPath } = useIndexData();
  const { selected, ontologyEnabled, isStaged, toggleStaged, pinToBoard, isPinned, select } =
    useWorkspace();

  const panel = useSidePanel();
  const [movePaths, setMovePaths] = useState<string[] | null>(null);
  const [native, setNative] = useState(false);
  useEffect(() => {
    let alive = true;
    void isNativeRuntime()
      .then((v) => alive && setNative(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const node = selected ? tree?.byPath.get(selected.path) : undefined;
  const pinned = selected ? isPinned(selected.path) : false;
  const lensRow: NativeTreemapLensFolder | null = selected
    ? lensByPath.get(selected.path) ?? null
    : null;
  const verdict = selected && ontologyEnabled && lensRow ? verdictForFolder(lensRow) : null;
  const reclaimable = lensRow?.reclaimable_bytes ?? 0;
  const reasonLabel = lensRow?.cleanup_reason
    ? REASON_LABELS[lensRow.cleanup_reason] ?? lensRow.cleanup_reason
    : null;
  const isFile = selected?.kind === "file";
  const staged = selected ? isStaged(selected.path) : false;
  const stageable = verdict ? canStage(verdict, reclaimable) : false;

  const fileMeta = useMemo(
    () => (selected && isFile ? overview?.files.find((f) => f.path === selected.path) ?? null : null),
    [overview, selected, isFile]
  );

  /** Category composition of the selected folder (base index data, no ontology needed). */
  const composition: Segment[] = useMemo(() => {
    if (!selected || isFile) return [];
    return (overview?.folder_media ?? [])
      .filter((fm) => fm.folder_path === selected.path && fm.total_bytes > 0)
      .map((fm) => {
        const cat = categoryOf(fm.media_kind);
        return { key: cat.kind, label: cat.label, value: fm.total_bytes, color: cat.color };
      })
      .sort((a, b) => b.value - a.value);
  }, [overview, selected, isFile]);

  const onStage = useCallback(() => {
    if (!selected || !verdict) return;
    toggleStaged({
      path: selected.path,
      name: selected.name,
      bytes: reclaimable > 0 ? reclaimable : selected.bytes,
      reason: lensRow?.cleanup_reason ?? null,
      verdict,
      kind: "folder",
    });
  }, [selected, verdict, reclaimable, lensRow, toggleStaged]);

  const onStageFile = useCallback(() => {
    if (!selected) return;
    toggleStaged({
      path: selected.path,
      name: selected.name,
      bytes: selected.bytes,
      reason: null,
      verdict: "review",
      kind: "file",
    });
  }, [selected, toggleStaged]);

  // ⇧↵ stages the current selection — same gating as the footer button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (isFile) onStageFile();
      else if (ontologyEnabled && (stageable || staged) && verdict !== "protected") onStage();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFile, ontologyEnabled, stageable, staged, verdict, onStage, onStageFile]);

  const vu = verdict ? VERDICT_UI[verdict] : null;
  const VerdictIcon = vu?.icon;
  const showStageButton = Boolean(selected && (isFile || ontologyEnabled));

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex flex-none items-center px-3.5 pt-3 pb-1">
        <SectionLabel className="min-w-0 flex-1">Inspector</SectionLabel>
        {panel ? (
          <IconButton icon={PanelRightClose} label="Hide panel (Ctrl+I)" size={13} onClick={panel.collapse} />
        ) : null}
      </div>

      {!selected ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-3.5 pb-3.5">
          <EmptyState
            icon={MousePointerClick}
            title="Select anything to inspect it"
            hint="Click a folder on the treemap or a file in Files — size, what it is, and whether it's safe to remove land here."
          />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pt-1.5 pb-3.5">
            {/* Title */}
            <div className="mb-1 flex items-center gap-2">
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-lg border border-line bg-inset text-muted">
                {isFile ? (
                  <FileIcon size={14} strokeWidth={2} aria-hidden />
                ) : (
                  <Folder size={14} strokeWidth={2} aria-hidden />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate text-15 font-semibold text-ink">
                {selected.name}
              </span>
            </div>
            <div className="mono mb-3.5 truncate text-105 text-dim" title={selected.path}>
              {selected.path}
            </div>

            {isFile ? <FilePreview path={selected.path} /> : null}

            {/* Facts */}
            <div className="mb-3.5 grid grid-cols-2 gap-2">
              <Fact label="Size" value={formatBytes(selected.bytes)} />
              {isFile
                ? fileMeta?.modified_at != null && (
                    <Fact label="Modified" value={fmtDate(fileMeta.modified_at)} />
                  )
                : <Fact label="Files" value={node ? formatCount(node.files) : "—"} />}
            </div>

            {isFile ? (
              <>
                {fileMeta ? (
                  <Card className="mb-3.5 flex items-center gap-2 p-2.5">
                    <span
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: categoryOf(fileMeta.media_kind).color }}
                      aria-hidden
                    />
                    <span className="text-115 text-ink-soft">
                      {categoryOf(fileMeta.media_kind).label}
                    </span>
                    {fileMeta.extension ? (
                      <span className="ml-auto">
                        <Tag>{fileMeta.extension}</Tag>
                      </span>
                    ) : null}
                  </Card>
                ) : null}
                <div className="text-11 leading-relaxed text-faint">
                  Verdicts are folder-level — select this file's folder on the map for the full
                  picture. Staged files are re-verified before removal.
                </div>
              </>
            ) : (
              <>
                {/* Category composition */}
                {composition.length > 0 ? (
                  <div className="mb-4">
                    <SectionLabel className="mb-1.5">What's inside</SectionLabel>
                    <CategoryBar segments={composition} height={10} />
                    <div className="mt-2 flex flex-col gap-1">
                      {composition.slice(0, 3).map((seg) => (
                        <div key={seg.key} className="flex items-center gap-1.5 text-11 text-muted">
                          <span
                            className="h-1.5 w-1.5 flex-none rounded-full"
                            style={{ background: seg.color }}
                            aria-hidden
                          />
                          <span className="truncate">{seg.label}</span>
                          <span className="mono ml-auto text-dim">{formatBytes(seg.value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {!ontologyEnabled ? (
                  <EnableIntelligenceCard />
                ) : (
                  <>
                    <div className="mb-4">
                      <SectionLabel className="mb-1.5">Why it exists</SectionLabel>
                      <div className="text-125 leading-relaxed text-ink-soft">
                        {lensRow
                          ? explainFolder(lensRow)
                          : "Not yet classified — re-run enrichment to analyze this folder."}
                      </div>
                    </div>

                    <div>
                      <SectionLabel className="mb-1.5">Safety verdict</SectionLabel>
                      {vu && VerdictIcon ? (
                        <div className={`rounded-lg border p-3 ${vu.cls}`}>
                          <div className="mb-1 flex items-center gap-2 text-125 font-semibold">
                            <VerdictIcon size={14} strokeWidth={2} aria-hidden />
                            {vu.label}
                          </div>
                          <div className="text-115 leading-snug opacity-90">
                            {reclaimable > 0 ? (
                              <>
                                <span className="mono font-semibold">
                                  {formatBytes(reclaimable)}
                                </span>{" "}
                                reclaimable{reasonLabel ? ` · ${reasonLabel}` : ""}
                              </>
                            ) : verdict === "protected" ? (
                              "Protected — never auto-staged."
                            ) : (
                              "In active use — nothing reclaimable."
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="text-115 italic text-label">Not classified.</div>
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer — pinned actions */}
          <div className="flex flex-none flex-col gap-2 border-t border-line p-3">
            {isFile ? (
              <Button
                variant={staged ? "subtle" : "primary"}
                icon={staged ? Check : undefined}
                className="w-full"
                onClick={onStageFile}
              >
                {staged ? "Staged — remove" : "Add to cleanup tray"}
              </Button>
            ) : ontologyEnabled ? (
              <Button
                variant={staged ? "subtle" : "primary"}
                icon={staged ? Check : undefined}
                className="w-full"
                disabled={!staged && !stageable}
                onClick={onStage}
              >
                {verdict === "protected"
                  ? "Protected"
                  : staged
                    ? "Staged — remove"
                    : stageable
                      ? "Add to cleanup tray"
                      : "Nothing to reclaim"}
              </Button>
            ) : null}

            <div className="flex items-center gap-1">
              <IconButton
                icon={Network}
                label={pinned ? "Already on board" : "Pin to board"}
                active={pinned}
                disabled={pinned}
                onClick={() =>
                  pinToBoard({ path: selected.path, name: selected.name, bytes: selected.bytes })
                }
              />
              {isFile ? (
                <IconButton
                  icon={FolderInput}
                  label="Move to folder…"
                  onClick={() => setMovePaths([selected.path])}
                />
              ) : null}
              {native ? (
                <IconButton
                  icon={ExternalLink}
                  label="Reveal in Explorer"
                  onClick={() => void revealInExplorer(selected.path).catch(() => {})}
                />
              ) : null}
              {showStageButton ? (
                <span className="ml-auto flex items-center gap-1 text-9 text-faint">
                  <Kbd>Shift</Kbd>
                  <Kbd>Enter</Kbd>
                  stages
                </span>
              ) : null}
            </div>
          </div>
        </>
      )}

      {movePaths ? (
        <MoveDialog
          paths={movePaths}
          onClose={() => setMovePaths(null)}
          // The moved file's path is stale — drop the selection instead of showing it.
          onMoved={() => select(null)}
        />
      ) : null}
    </div>
  );
}
