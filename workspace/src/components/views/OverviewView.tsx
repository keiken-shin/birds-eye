import { useMemo } from "react";
import {
  CalendarClock,
  Copy,
  Database,
  Files as FilesIcon,
  FolderTree,
  HardDrive,
  Recycle,
  ScanLine,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { scopeChildren } from "../../lib/folderTree";
import { categoryOf } from "../../lib/categories";
import { Card, EmptyState, SectionLabel, StatCard, useCountUp } from "../ui/Card";
import { CategoryBar, Donut, BarList, DistBars, type Segment } from "../ui/charts";
import { ViewHeader } from "./ViewHeader";
import type { StageView } from "../../state/types";

const AGE_LABELS: Record<string, string> = {
  lt1mo: "<1 mo",
  "1to3mo": "1–3 mo",
  "3to6mo": "3–6 mo",
  "6to12mo": "6–12 mo",
  "1to2yr": "1–2 yr",
  gt2yr: "2 yr+",
};
const AGE_ORDER = ["lt1mo", "1to3mo", "3to6mo", "6to12mo", "1to2yr", "gt2yr"];
// Freshness ramp: recent = calm teal → ancient = warm alarm (still quiet).
const AGE_COLORS = ["#22a3c9", "#4b82e8", "#bd8813", "#d1651f", "#d0544a", "#8a4a42"];

export function OverviewView() {
  const { status, overview, tree, lensByPath, reclaimableTotal, activeEntry } = useIndexData();
  const { setView, setScopePath, setOverlay, select } = useWorkspace();

  const totalBytes = activeEntry?.bytes_scanned ?? 0;
  const totalFiles = activeEntry?.files_scanned ?? 0;
  const dupWaste = useMemo(
    () => (overview?.duplicate_groups ?? []).reduce((s, g) => s + g.reclaimable_bytes, 0),
    [overview]
  );

  const categorySegments: Segment[] = useMemo(() => {
    const media = [...(overview?.media ?? [])].sort((a, b) => b.total_bytes - a.total_bytes);
    return media
      .filter((m) => m.total_bytes > 0)
      .map((m) => {
        const cat = categoryOf(m.media_kind);
        return { key: cat.kind, label: cat.label, value: m.total_bytes, color: cat.color };
      });
  }, [overview]);

  const topConsumers = useMemo(() => {
    if (!tree) return [];
    const children = scopeChildren(tree, []);
    // Dominant media kind per folder colors its bar — the second encoding next to size.
    const domByFolder = new Map<string, string>();
    for (const fm of overview?.folder_media ?? []) {
      const prev = domByFolder.get(fm.folder_path);
      if (!prev) domByFolder.set(fm.folder_path, fm.media_kind);
    }
    return children.slice(0, 7).map((node) => ({
      node,
      kind: domByFolder.get(node.path) ?? "other",
    }));
  }, [tree, overview]);

  const ageBuckets = useMemo(() => {
    const byKey = new Map((overview?.age_buckets ?? []).map((b) => [b.bucket, b]));
    return AGE_ORDER.map((key, i) => ({
      key,
      label: AGE_LABELS[key],
      value: byKey.get(key)?.total_bytes ?? 0,
      color: AGE_COLORS[i],
      meta: `last modified ${AGE_LABELS[key]} ago · ${formatCount(byKey.get(key)?.file_count ?? 0)} files`,
    }));
  }, [overview]);

  const staleBytes = useMemo(
    () =>
      (overview?.age_buckets ?? [])
        .filter((b) => b.bucket === "1to2yr" || b.bucket === "gt2yr")
        .reduce((s, b) => s + b.total_bytes, 0),
    [overview]
  );

  const animatedTotal = useCountUp(totalBytes);
  const animatedFiles = useCountUp(totalFiles);
  const animatedReclaim = useCountUp(reclaimableTotal);
  const animatedDup = useCountUp(dupWaste);

  if (status === "no-index") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={ScanLine}
          title="Scan a folder to see your storage"
          hint="Bird's Eye builds a local index of sizes, types, ages and duplicates — everything stays on this machine."
          action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ViewHeader
        title="Overview"
        sub={activeEntry?.root_path ?? undefined}
        actions={
          reclaimableTotal > 0 ? (
            <button
              type="button"
              onClick={() => setView("cleanup")}
              className="rounded-full border border-primary-edge bg-primary-wash px-3 py-1 text-11 text-primary-ink transition-[filter] hover:brightness-125"
            >
              <span className="mono font-semibold">{formatBytes(reclaimableTotal)}</span> can likely be freed →
            </button>
          ) : undefined
        }
      />

      <div className="mx-auto flex max-w-[1080px] flex-col gap-4 p-4">
        {/* Stat tiles */}
        <div className="be-rise grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard label="Indexed" value={formatBytes(animatedTotal)} icon={HardDrive} tint="var(--color-history)" sub={<span className="mono">{formatCount(totalFiles)} files</span>} />
          <StatCard label="Files" value={formatCount(Math.round(animatedFiles))} icon={FilesIcon} tint="var(--color-cat-photo)" sub={<span className="mono">{formatCount(activeEntry?.folders_scanned ?? 0)} folders</span>} />
          <StatCard label="Reclaimable" value={formatBytes(animatedReclaim)} icon={Sparkles} tint="var(--color-primary)" sub="review & clean safely" onClick={() => setView("cleanup")} />
          <StatCard label="Duplicate waste" value={formatBytes(animatedDup)} icon={Copy} tint="var(--color-danger)" sub={`${overview?.duplicate_groups.length ?? 0} groups`} onClick={() => setView("duplicates")} />
        </div>

        {/* Composition bar */}
        <Card className="be-rise be-d1 p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <SectionLabel>What's on this disk</SectionLabel>
            <span className="mono text-11 text-dim">{formatBytes(totalBytes)}</span>
          </div>
          <CategoryBar segments={categorySegments} height={16} />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {categorySegments.map((seg) => (
              <span key={seg.key} className="flex items-center gap-1.5 text-11 text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: seg.color }} />
                {seg.label}
                <span className="mono text-dim">{formatBytes(seg.value)}</span>
              </span>
            ))}
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {/* Donut */}
          <Card className="be-rise be-d2 p-4">
            <SectionLabel className="mb-3">Space by category</SectionLabel>
            <div className="flex items-center justify-center gap-6">
              <Donut
                segments={categorySegments.slice(0, 8)}
                center={{ value: formatBytes(totalBytes), label: "indexed" }}
              />
              <div className="flex flex-col gap-1.5">
                {categorySegments.slice(0, 6).map((seg) => (
                  <div key={seg.key} className="flex items-center gap-2 text-11">
                    <span className="h-2 w-2 rounded-full" style={{ background: seg.color }} />
                    <span className="w-20 text-muted">{seg.label}</span>
                    <span className="mono text-dim">
                      {totalBytes ? Math.round((seg.value / totalBytes) * 100) : 0}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Top consumers */}
          <Card className="be-rise be-d2 p-4">
            <SectionLabel className="mb-3">Top consumers</SectionLabel>
            <BarList
              rows={topConsumers.map(({ node, kind }) => ({
                key: node.path,
                label: node.name,
                value: node.bytes,
                color: categoryOf(kind).color,
                onClick: () => {
                  setScopePath([node.path]);
                  select({ kind: "folder", path: node.path, name: node.name, bytes: node.bytes });
                  setView("treemap");
                },
              }))}
            />
          </Card>

          {/* Quick actions */}
          <Card className="be-rise be-d3 p-4">
            <SectionLabel className="mb-3">Quick actions</SectionLabel>
            <div className="grid grid-cols-2 gap-2.5">
              <QuickAction icon={Copy} tint="var(--color-danger)" title="Find duplicates" sub={`${formatBytes(dupWaste)} recoverable`} onClick={() => setView("duplicates")} />
              <QuickAction icon={Sparkles} tint="var(--color-primary)" title="Clean up" sub={`${formatBytes(reclaimableTotal)} reclaimable`} onClick={() => setView("cleanup")} />
              <QuickAction icon={FolderTree} tint="var(--color-cat-archive)" title="Explore treemap" sub="visual space map" onClick={() => setView("treemap")} />
              <QuickAction icon={Database} tint="var(--color-cat-document)" title="Largest files" sub="top space hogs" onClick={() => setView("files")} />
            </div>
          </Card>

          {/* Age snapshot */}
          <Card className="be-rise be-d3 p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <SectionLabel>How old is it?</SectionLabel>
              <button
                type="button"
                onClick={() => setView("timeline")}
                className="flex items-center gap-1 text-11 text-faint transition-colors hover:text-ink"
              >
                <CalendarClock size={11} aria-hidden /> Timeline →
              </button>
            </div>
            <DistBars buckets={ageBuckets} height={128} />
            {staleBytes > 0 ? (
              <div className="mt-3 flex items-center gap-2 text-11 text-faint">
                <Recycle size={12} className="text-primary-ink" aria-hidden />
                <span>
                  <span className="mono font-semibold text-ink-soft">{formatBytes(staleBytes)}</span> hasn't
                  been touched in over a year
                </span>
              </div>
            ) : null}
          </Card>
        </div>
      </div>
    </div>
  );
}

function QuickAction({
  icon: Icon,
  tint,
  title,
  sub,
  onClick,
}: {
  icon: LucideIcon;
  tint: string;
  title: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-[10px] border border-line bg-window p-3 text-left transition-colors hover:border-line-strong"
    >
      <span
        className="flex h-9 w-9 flex-none items-center justify-center rounded-lg transition-transform group-hover:scale-105"
        style={{ background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint }}
      >
        <Icon size={16} strokeWidth={2} aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-125 font-medium text-ink">{title}</span>
        <span className="mono block truncate text-10 text-faint">{sub}</span>
      </span>
    </button>
  );
}
