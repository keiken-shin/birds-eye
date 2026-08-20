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
import { formatBytes, formatCount } from "@bridge/domain";
import { VERDICT_STYLES } from "../../lib/verdict";
import {
  folderRecommendations,
  staleFileRecommendations,
  type RecItem,
} from "../../lib/recommendations";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { Card, EmptyState } from "../ui/Card";
import { Button } from "../ui/Button";
import { VerdictTag } from "../ui/Chip";
import { EnableIntelligenceCard } from "../EnableIntelligenceCard";
import { FindingsReview } from "../FindingsReview";
import { ViewHeader } from "./ViewHeader";
import type { Verdict } from "../../state/types";

/* ------------------------------------------------------------------ */
/* Risk — the legend and the 3px row edge share these. Two of the three */
/* safety words; "Don't touch" never reaches this view.                 */
/* ------------------------------------------------------------------ */

type Risk = "safe" | "review";

const RISK: Record<Risk, { color: string; label: string }> = {
  safe: { color: "var(--color-primary)", label: VERDICT_STYLES.safe.label },
  review: { color: "var(--color-review-bd)", label: VERDICT_STYLES.review.label },
};

type RecGroup = {
  id: string;
  title: string;
  icon: LucideIcon;
  tint: string;
  risk: Risk;
  items: RecItem[];
};

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
          title: "Build output and caches",
          icon: Wrench,
          tint: "var(--color-cat-code)",
          risk: "safe",
          items: folderRecommendations(rows, new Set(["safe-derivative", "scratch"]), root),
        },
        {
          id: "backups",
          title: "Backups you already have twice",
          icon: HardDriveDownload,
          tint: "var(--color-cat-archive)",
          risk: "review",
          items: folderRecommendations(rows, new Set(["redundant-backup"]), root),
        },
        {
          id: "finished",
          title: "Left over from projects you've finished",
          icon: FolderX,
          tint: "var(--color-cat-document)",
          risk: "review",
          items: folderRecommendations(rows, new Set(["finished-project-cruft"]), root),
        }
      );
    }
    out.push({
      id: "stale",
      title: "Big files you haven't touched in a year",
      icon: Hourglass,
      tint: "var(--color-review-bd)",
      risk: "review",
      items: staleFileRecommendations(overview?.files ?? []),
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
    select({ kind: item.kind, path: item.path, name: item.name, bytes: item.bytes, fileId: item.fileId });
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
        fileId: item.fileId,
      });
    }
    setPicked(new Set());
  };

  if (status === "no-index") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Clean up" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={ScanLine}
            title="Scan a folder to see what's safe to delete"
            hint="Bird's Eye reads your own folders and tells you what it found, and why. Nothing is uploaded."
            action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
          />
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Clean up" />
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
        title="Clean up"
        sub={
          <>
            <span className="mono font-semibold text-primary-ink">{formatBytes(listedTotal)}</span>{" "}
            you can free
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
          {/* Findings waiting on a yes or no. Above the list because that is
              where saying yes shows up — two of the reasons below only exist
              once the relation behind them is confirmed. */}
          <FindingsReview />

          {/* Safety legend */}
          <Card className="be-rise flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5">
            <span className="text-10 font-semibold tracking-[0.12em] text-label uppercase">
              Safety
            </span>
            {(Object.keys(RISK) as Risk[]).map((r) => (
              <span key={r} className="flex items-center gap-1.5 text-11 text-muted">
                <span className="h-2 w-2 rounded-full" style={{ background: RISK[r].color }} aria-hidden />
                {RISK[r].label}
              </span>
            ))}
          </Card>

          {/* Analysis off → groups 1–3 replaced by the opt-in card */}
          {!ontologyEnabled ? (
            <Card className={`be-rise ${nextDelay()} p-4`}>
              <div className="mb-3 text-10 font-semibold tracking-[0.12em] text-label uppercase">
                Turn the analysis on
              </div>
              <EnableIntelligenceCard />
            </Card>
          ) : null}

          {nothingListed ? (
            <Card className={`be-rise ${nextDelay()}`}>
              <EmptyState
                icon={Sparkles}
                title="Nothing here is obviously safe to delete"
                hint="No build caches, spare backups or big untouched files stand out in this index right now."
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
                count={`${formatCount(dupGroups.length)} groups · ${formatBytes(dupWaste)} you can free`}
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
            Bird's Eye checks every staged item again before it removes anything — recycle bin
            first, restorable for 30 days.
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
        count={`${formatCount(group.items.length)} ${group.items.length === 1 ? "item" : "items"} · ${formatBytes(totalBytes)} you can free`}
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
              {/* The row is the ad: name · size · how long since you touched it · why. */}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-125 font-medium text-ink">{item.name}</span>
                  <span className="mono flex-none text-11 font-semibold text-ink-soft">
                    {formatBytes(item.bytes)}
                  </span>
                  <span className="flex-none truncate text-10 text-faint">
                    {item.age ?? "date unknown"}
                  </span>
                  <span className="min-w-0 truncate text-10 text-dim">{item.why}</span>
                </span>
                <span className="mono block truncate text-10 text-dim">{item.path}</span>
              </span>
              <VerdictTag verdict={item.verdict} label={staged ? "Staged" : undefined} />
            </button>
          );
        })}
      </div>
    </Card>
  );
}
