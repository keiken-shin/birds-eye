import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  FolderX,
  HardDriveDownload,
  Hourglass,
  Minus,
  Recycle,
  ScanLine,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { formatBytes, formatCount, lastSegment } from "@bridge/domain";
import { REASON_LABELS, type NativeTreemapLensFolder } from "@bridge/nativeClient";
import { verdictForFolder } from "../../lib/verdict";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { Card, EmptyState } from "../ui/Card";
import { Button } from "../ui/Button";
import { VerdictTag } from "../ui/Chip";
import { EnableIntelligenceCard } from "../EnableIntelligenceCard";
import { ViewHeader } from "./ViewHeader";
import type { Verdict } from "../../state/types";

/* ------------------------------------------------------------------ */
/* Risk taxonomy — the legend and the 3px row edge share these.        */
/* ------------------------------------------------------------------ */

type Risk = "safe" | "review" | "caution";

const RISK: Record<Risk, { color: string; label: string }> = {
  safe: { color: "var(--color-primary)", label: "Safe to remove" },
  review: { color: "var(--color-warn)", label: "Review first" },
  caution: { color: "var(--color-danger)", label: "Use caution" },
};

type RecItem = {
  path: string;
  name: string;
  /** Reclaimable bytes when known, else file size. */
  bytes: number;
  /** Short "why" line — reason label or age. */
  sub: string;
  verdict: Verdict;
  kind: "folder" | "file";
  reason: string | null;
};

type RecGroup = {
  id: string;
  title: string;
  icon: LucideIcon;
  tint: string;
  risk: Risk;
  items: RecItem[];
};

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const isAncestor = (parent: string, child: string) => child.startsWith(parent + "/");

/** Lens rows for the given reasons — root excluded, zero-reclaim excluded, shallowest wins. */
function lensGroupItems(
  rows: NativeTreemapLensFolder[],
  reasons: Set<string>,
  rootPath: string | null
): RecItem[] {
  const root = rootPath ? norm(rootPath) : null;
  const cands = rows.filter(
    (r) =>
      r.cleanup_reason !== null &&
      reasons.has(r.cleanup_reason) &&
      r.reclaimable_bytes > 0 &&
      norm(r.folder_path) !== root
  );
  const paths = cands.map((r) => norm(r.folder_path));
  return cands
    .filter((_, i) => !paths.some((p, k) => k !== i && isAncestor(p, paths[i])))
    .sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes)
    .map((r) => ({
      path: r.folder_path,
      name: lastSegment(r.folder_path),
      bytes: r.reclaimable_bytes,
      sub: r.cleanup_reason ? (REASON_LABELS[r.cleanup_reason] ?? r.cleanup_reason) : "",
      verdict: verdictForFolder(r),
      kind: "folder" as const,
      reason: r.cleanup_reason,
    }));
}

function ageLabel(seconds: number): string {
  const days = seconds / 86_400;
  return days >= 365 ? `${(days / 365).toFixed(1)} yr` : `${Math.round(days / 30)} mo`;
}

export function CleanupView() {
  const { status, error, overview, lensByPath, activeEntry, refreshData } = useIndexData();
  const { ontologyEnabled, toggleStaged, isStaged, setView, setOverlay, select } = useWorkspace();
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const dupGroups = overview?.duplicate_groups ?? [];
  const dupWaste = useMemo(
    () => dupGroups.reduce((s, g) => s + g.reclaimable_bytes, 0),
    [dupGroups]
  );

  const groups: RecGroup[] = useMemo(() => {
    const rows = Array.from(lensByPath.values());
    const root = activeEntry?.root_path ?? null;
    const out: RecGroup[] = [];
    if (ontologyEnabled) {
      out.push(
        {
          id: "build",
          title: "Build outputs & caches",
          icon: Wrench,
          tint: "var(--color-cat-code)",
          risk: "safe",
          items: lensGroupItems(rows, new Set(["safe-derivative", "scratch"]), root),
        },
        {
          id: "backups",
          title: "Redundant backups",
          icon: HardDriveDownload,
          tint: "var(--color-cat-archive)",
          risk: "review",
          items: lensGroupItems(rows, new Set(["redundant-backup"]), root),
        },
        {
          id: "finished",
          title: "Finished project leftovers",
          icon: FolderX,
          tint: "var(--color-cat-document)",
          risk: "review",
          items: lensGroupItems(rows, new Set(["finished-project-cruft"]), root),
        }
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoff = nowSec - 365 * 86_400;
    out.push({
      id: "stale",
      title: "Untouched for 1+ year",
      icon: Hourglass,
      tint: "var(--color-warn)",
      risk: "caution",
      items: (overview?.files ?? [])
        .filter((f) => f.modified_at !== null && f.modified_at < cutoff)
        .sort((a, b) => b.size - a.size)
        .slice(0, 8)
        .map((f) => ({
          path: f.path,
          name: lastSegment(f.path),
          bytes: f.size,
          sub: `untouched ${ageLabel(nowSec - (f.modified_at ?? nowSec))}`,
          verdict: "review" as const,
          kind: "file" as const,
          reason: null,
        })),
    });
    return out.filter((g) => g.items.length > 0);
  }, [lensByPath, overview, activeEntry, ontologyEnabled]);

  const itemByPath = useMemo(
    () => new Map(groups.flatMap((g) => g.items).map((i) => [i.path, i])),
    [groups]
  );

  const listedTotal = useMemo(
    () => groups.reduce((s, g) => s + g.items.reduce((x, i) => x + i.bytes, 0), 0) + dupWaste,
    [groups, dupWaste]
  );

  const togglePick = (item: RecItem) => {
    select({ kind: item.kind, path: item.path, name: item.name, bytes: item.bytes });
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(item.path)) next.delete(item.path);
      else next.add(item.path);
      return next;
    });
  };

  const toggleGroup = (g: RecGroup) => {
    const selectable = g.items.filter((i) => !isStaged(i.path));
    const allOn = selectable.length > 0 && selectable.every((i) => picked.has(i.path));
    setPicked((prev) => {
      const next = new Set(prev);
      for (const i of selectable) {
        if (allOn) next.delete(i.path);
        else next.add(i.path);
      }
      return next;
    });
  };

  const stageSelected = () => {
    for (const path of picked) {
      const item = itemByPath.get(path);
      if (!item || isStaged(path)) continue;
      toggleStaged({
        path: item.path,
        name: item.name,
        bytes: item.bytes,
        reason: item.reason,
        verdict: item.verdict,
        kind: item.kind,
      });
    }
    setPicked(new Set());
  };

  if (status === "no-index") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Cleanup" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={ScanLine}
            title="Scan a folder to get recommendations"
            hint="Cleanup curates what's safely reclaimable from your local index — nothing leaves this machine."
            action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
          />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Cleanup" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={Hourglass}
            title="Couldn't read the index"
            hint={error}
            action={{ label: "Retry", onClick: () => void refreshData() }}
          />
        </div>
      </div>
    );
  }

  const nothingListed = groups.length === 0 && dupGroups.length === 0;
  let delayIdx = 0;
  const nextDelay = () => `be-d${Math.min(++delayIdx, 4)}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Cleanup"
        sub={
          <>
            Smart recommendations —{" "}
            <span className="mono font-semibold text-primary-ink">{formatBytes(listedTotal)}</span>{" "}
            recoverable
          </>
        }
        actions={
          <Button variant="primary" size="sm" disabled={picked.size === 0} onClick={stageSelected}>
            Stage selected
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-4 p-4">
          {/* Risk legend */}
          <Card className="be-rise flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5">
            <span className="text-10 font-semibold tracking-[0.12em] text-label uppercase">Risk</span>
            {(Object.keys(RISK) as Risk[]).map((r) => (
              <span key={r} className="flex items-center gap-1.5 text-11 text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: RISK[r].color }} aria-hidden />
                {RISK[r].label}
              </span>
            ))}
          </Card>

          {/* Intelligence off → groups 1–3 replaced by the opt-in card */}
          {!ontologyEnabled ? (
            <Card className={`be-rise ${nextDelay()} p-4`}>
              <div className="mb-3 text-10 font-semibold tracking-[0.12em] text-label uppercase">
                Unlock smart recommendations
              </div>
              <EnableIntelligenceCard />
            </Card>
          ) : null}

          {nothingListed ? (
            <Card className={`be-rise ${nextDelay()}`}>
              <EmptyState
                icon={Sparkles}
                title="Nothing obviously reclaimable"
                hint="No caches, redundant backups or stale giants stand out in this index right now."
              />
            </Card>
          ) : null}

          {/* Lens-backed groups (1–3) */}
          {groups
            .filter((g) => g.id !== "stale")
            .map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                delay={nextDelay()}
                picked={picked}
                isStaged={isStaged}
                onToggleGroup={() => toggleGroup(g)}
                onToggleItem={togglePick}
              />
            ))}

          {/* Group 4 — duplicates summary (not selectable, hands off to the workbench) */}
          {dupGroups.length > 0 ? (
            <Card className={`be-rise ${nextDelay()} overflow-hidden`}>
              <GroupHeader
                icon={Copy}
                tint="var(--color-danger)"
                title="Duplicate files"
                count={`${formatCount(dupGroups.length)} groups · ${formatBytes(dupWaste)} reclaimable`}
                risk="review"
              />
              <div
                className="flex items-center gap-3 border-l-[3px] px-3.5 py-2.5"
                style={{ borderLeftColor: RISK.review.color }}
              >
                <span className="min-w-0 flex-1 truncate text-11 text-muted">
                  Resolved per group — pick which copy to keep.
                </span>
                <Button variant="subtle" size="sm" onClick={() => setView("duplicates")}>
                  Review duplicates →
                </Button>
              </div>
            </Card>
          ) : null}

          {/* Group 5 — stale giants */}
          {groups
            .filter((g) => g.id === "stale")
            .map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                delay={nextDelay()}
                picked={picked}
                isStaged={isStaged}
                onToggleGroup={() => toggleGroup(g)}
                onToggleItem={togglePick}
              />
            ))}

          {/* Footer note */}
          <div className="be-rise be-d4 flex items-center gap-2 px-1 pb-2 text-11 text-faint">
            <Recycle size={12} className="flex-none text-primary-ink" aria-hidden />
            Staged items go through Review &amp; clean — recycle bin first, restorable for 30 days.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

type CheckState = "off" | "on" | "partial" | "staged";

function CheckSquare({ state }: { state: CheckState }) {
  if (state === "staged") {
    return (
      <span className="flex h-4 w-4 flex-none items-center justify-center rounded-[5px] bg-primary-dim text-primary-ink">
        <Check size={11} strokeWidth={2.2} aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={`flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border transition-colors ${
        state === "off"
          ? "border-line-input bg-inset text-transparent"
          : "border-primary bg-primary text-on-primary"
      }`}
    >
      {state === "partial" ? (
        <Minus size={11} strokeWidth={2.2} aria-hidden />
      ) : (
        <Check size={11} strokeWidth={2.2} aria-hidden />
      )}
    </span>
  );
}

function GroupHeader({
  icon: Icon,
  tint,
  title,
  count,
  risk,
  check,
  onCheck,
}: {
  icon: LucideIcon;
  tint: string;
  title: string;
  count: string;
  risk: Risk;
  check?: CheckState;
  onCheck?: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line-soft px-3.5 py-2.5">
      {check && onCheck ? (
        <button
          type="button"
          aria-label={`Select all — ${title}`}
          title={`Select all — ${title}`}
          onClick={onCheck}
          className="flex-none rounded p-0.5 transition-transform hover:scale-110"
        >
          <CheckSquare state={check} />
        </button>
      ) : (
        <span className="w-5 flex-none" aria-hidden />
      )}
      <span
        className="flex h-8 w-8 flex-none items-center justify-center rounded-lg"
        style={{ background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint }}
      >
        <Icon size={15} strokeWidth={2} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-125 font-semibold text-ink">{title}</div>
        <div className="mono truncate text-10 text-dim">{count}</div>
      </div>
      <span className="flex flex-none items-center gap-1.5 text-10 text-faint">
        <span className="h-2 w-2 rounded-full" style={{ background: RISK[risk].color }} aria-hidden />
        {RISK[risk].label}
      </span>
    </div>
  );
}

function GroupCard({
  group,
  delay,
  picked,
  isStaged,
  onToggleGroup,
  onToggleItem,
}: {
  group: RecGroup;
  delay: string;
  picked: Set<string>;
  isStaged: (path: string) => boolean;
  onToggleGroup: () => void;
  onToggleItem: (item: RecItem) => void;
}) {
  const selectable = group.items.filter((i) => !isStaged(i.path));
  const onCount = selectable.filter((i) => picked.has(i.path)).length;
  const headerCheck: CheckState =
    selectable.length > 0 && onCount === selectable.length ? "on" : onCount > 0 ? "partial" : "off";
  const totalBytes = group.items.reduce((s, i) => s + i.bytes, 0);

  return (
    <Card className={`be-rise ${delay} overflow-hidden`}>
      <GroupHeader
        icon={group.icon}
        tint={group.tint}
        title={group.title}
        count={`${formatCount(group.items.length)} ${group.items.length === 1 ? "item" : "items"} · ${formatBytes(totalBytes)} reclaimable`}
        risk={group.risk}
        check={headerCheck}
        onCheck={onToggleGroup}
      />
      <div className="divide-y divide-line-soft">
        {group.items.map((item) => {
          const staged = isStaged(item.path);
          const on = !staged && picked.has(item.path);
          return (
            <button
              key={item.path}
              type="button"
              disabled={staged}
              onClick={() => onToggleItem(item)}
              className={`flex w-full items-center gap-2.5 border-l-[3px] px-3 py-2 text-left transition-colors ${
                staged ? "opacity-45" : on ? "bg-primary-wash" : "hover:bg-window"
              }`}
              style={{ borderLeftColor: RISK[group.risk].color }}
            >
              <CheckSquare state={staged ? "staged" : on ? "on" : "off"} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-125 font-medium text-ink">{item.name}</span>
                  {item.sub ? (
                    <span className="flex-none truncate text-10 text-faint">{item.sub}</span>
                  ) : null}
                </span>
                <span className="mono block truncate text-10 text-dim">{item.path}</span>
              </span>
              <span className="mono flex-none text-115 font-semibold text-ink-soft">
                {formatBytes(item.bytes)}
              </span>
              <VerdictTag verdict={item.verdict} label={staged ? "STAGED" : undefined} />
            </button>
          );
        })}
      </div>
    </Card>
  );
}
