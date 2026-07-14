import { useMemo, type ReactNode } from "react";
import {
  Activity,
  CalendarClock,
  Check,
  Clock,
  Flame,
  Ghost,
  Hourglass,
  Plus,
  ScanLine,
  Snowflake,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { formatAge, formatBytes, formatCount, lastSegment } from "@bridge/domain";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { categoryOf } from "../../lib/categories";
import { Card, EmptyState, SectionLabel, StatCard, useCountUp } from "../ui/Card";
import { Button } from "../ui/Button";
import { AreaChart, DistBars, type AreaPoint } from "../ui/charts";
import { ViewHeader } from "./ViewHeader";

/* Same age constants as OverviewView — keep values identical. */
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

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parse a "YYYY-MM" bucket into the three display forms this view needs. */
function monthParts(bucket: string): { short: string; mid: string; long: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(bucket);
  if (!m) return null;
  const y = Number(m[1]);
  const mi = Number(m[2]) - 1;
  if (mi < 0 || mi > 11) return null;
  return {
    short: `${MONTHS_SHORT[mi]} ${String(y).slice(-2)}`, // axis: "Jan 25"
    mid: `${MONTHS_SHORT[mi]} ${y}`, // insights: "Aug 2025"
    long: `${MONTHS_LONG[mi]} ${y}`, // tooltips / subs: "August 2025"
  };
}

const DAY = 86_400;

/** Value emphasis inside an insight sentence. */
function Val({ children }: { children: ReactNode }) {
  return <span className="mono font-semibold text-ink-soft">{children}</span>;
}

type Insight = { key: string; icon: LucideIcon; tint: string; body: ReactNode };

function pctText(num: number, den: number): string {
  const p = (num / den) * 100;
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

export function TimelineView() {
  const { status, overview } = useIndexData();
  const { setOverlay, select, toggleStaged, isStaged } = useWorkspace();

  const timeline = useMemo(() => overview?.timeline ?? [], [overview]);
  const ages = useMemo(() => overview?.age_buckets ?? [], [overview]);
  const byAge = useMemo(() => new Map(ages.map((b) => [b.bucket, b])), [ages]);

  const activeBytes = byAge.get("lt1mo")?.total_bytes ?? 0;
  const activeFiles = byAge.get("lt1mo")?.file_count ?? 0;
  const staleYrBytes = (byAge.get("1to2yr")?.total_bytes ?? 0) + (byAge.get("gt2yr")?.total_bytes ?? 0);
  const staleYrFiles = (byAge.get("1to2yr")?.file_count ?? 0) + (byAge.get("gt2yr")?.file_count ?? 0);

  const busiest = useMemo(
    () =>
      timeline.reduce<(typeof timeline)[number] | null>(
        (best, t) => (best === null || t.total_bytes > best.total_bytes ? t : best),
        null
      ),
    [timeline]
  );
  const peak = useMemo(
    () =>
      timeline.reduce<(typeof timeline)[number] | null>(
        (best, t) => (best === null || t.file_count > best.file_count ? t : best),
        null
      ),
    [timeline]
  );
  const quietest = useMemo(
    () =>
      timeline.reduce<(typeof timeline)[number] | null>(
        (best, t) => (best === null || t.file_count < best.file_count ? t : best),
        null
      ),
    [timeline]
  );

  const points: AreaPoint[] = useMemo(
    () =>
      timeline.map((t) => {
        const parts = monthParts(t.bucket);
        return {
          label: parts?.short ?? t.bucket,
          value: t.total_bytes,
          meta: `${parts?.long ?? t.bucket} · ${formatCount(t.file_count)} files`,
        };
      }),
    [timeline]
  );

  const ageBuckets = useMemo(
    () =>
      AGE_ORDER.map((key, i) => ({
        key,
        label: AGE_LABELS[key],
        value: byAge.get(key)?.total_bytes ?? 0,
        color: AGE_COLORS[i],
        meta: `last modified ${AGE_LABELS[key]} ago · ${formatCount(byAge.get(key)?.file_count ?? 0)} files`,
      })),
    [byAge]
  );

  // Insights — each computed straight from the data; skipped when its inputs are empty.
  const insights = useMemo<Insight[]>(() => {
    const rows: Insight[] = [];
    if (peak) {
      const parts = monthParts(peak.bucket);
      rows.push({
        key: "peak",
        icon: Flame,
        tint: "var(--color-danger)",
        body: (
          <>
            Peak activity in <Val>{parts?.mid ?? peak.bucket}</Val> — <Val>{formatCount(peak.file_count)}</Val> files
            touched.
          </>
        ),
      });
    }
    if (quietest && timeline.length > 1) {
      const parts = monthParts(quietest.bucket);
      rows.push({
        key: "quiet",
        icon: Snowflake,
        tint: "var(--color-history)",
        body: (
          <>
            Quietest month was <Val>{parts?.mid ?? quietest.bucket}</Val> — <Val>{formatCount(quietest.file_count)}</Val>{" "}
            files touched.
          </>
        ),
      });
    }
    const totalAgeFiles = ages.reduce((s, b) => s + b.file_count, 0);
    const stale6moFiles =
      (byAge.get("6to12mo")?.file_count ?? 0) +
      (byAge.get("1to2yr")?.file_count ?? 0) +
      (byAge.get("gt2yr")?.file_count ?? 0);
    if (totalAgeFiles > 0) {
      rows.push({
        key: "stale6mo",
        icon: Clock,
        tint: "var(--color-warn)",
        body: (
          <>
            <Val>{pctText(stale6moFiles, totalAgeFiles)}</Val> of files (<Val>{formatCount(stale6moFiles)}</Val>) haven't
            been touched in 6 months or more.
          </>
        ),
      });
    }
    const totalAgeBytes = ages.reduce((s, b) => s + b.total_bytes, 0);
    if (totalAgeBytes > 0) {
      rows.push({
        key: "rot",
        icon: Ghost,
        tint: "var(--color-faint)",
        body: (
          <>
            <Val>{pctText(staleYrBytes, totalAgeBytes)}</Val> of indexed bytes — <Val>{formatBytes(staleYrBytes)}</Val> —
            are digital rot, unmodified for a year or more.
          </>
        ),
      });
    }
    if (timeline.length > 0) {
      const avg = timeline.reduce((s, t) => s + t.total_bytes, 0) / timeline.length;
      rows.push({
        key: "avg",
        icon: TrendingUp,
        tint: "var(--color-primary)",
        body: (
          <>
            An average month touches <Val>{formatBytes(avg)}</Val> across the last{" "}
            <Val>{timeline.length} months</Val>.
          </>
        ),
      });
    }
    return rows;
  }, [peak, quietest, timeline, ages, byAge, staleYrBytes]);

  // Large files not modified in over a year — the concrete "act on it" list.
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const staleFiles = useMemo(() => {
    const cutoff = now - 365 * DAY;
    return (overview?.files ?? [])
      .filter((f) => f.modified_at !== null && f.modified_at < cutoff)
      .sort((a, b) => b.size - a.size)
      .slice(0, 8);
  }, [overview, now]);

  const animatedActive = useCountUp(activeBytes);
  const animatedStale = useCountUp(staleYrBytes);
  const animatedBusiest = useCountUp(busiest?.total_bytes ?? 0);
  const busiestParts = busiest ? monthParts(busiest.bucket) : null;

  if (status === "no-index") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Timeline" sub="when your files were last touched" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={ScanLine}
            title="Scan a folder to see its timeline"
            hint="Bird's Eye reads last-modified dates during a scan and turns them into an activity history."
            action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader title="Timeline" sub="when your files were last touched" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-4 p-4">
          {/* Stat tiles */}
          <div className="be-rise grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Active last 30 days"
              value={formatBytes(animatedActive)}
              icon={Activity}
              tint="var(--color-cat-photo)"
              sub={<span className="mono">{formatCount(activeFiles)} files</span>}
            />
            <StatCard
              label="Untouched 1 yr+"
              value={formatBytes(animatedStale)}
              icon={Hourglass}
              tint="var(--color-warn)"
              sub={<span className="mono">{formatCount(staleYrFiles)} files</span>}
            />
            <StatCard
              label="Busiest month"
              value={busiest ? formatBytes(animatedBusiest) : "—"}
              icon={TrendingUp}
              tint="var(--color-history)"
              sub={busiestParts?.long ?? busiest?.bucket}
            />
          </div>

          {/* Monthly activity */}
          <Card className="be-rise be-d1 p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <SectionLabel>Monthly activity — bytes modified</SectionLabel>
              {timeline.length ? (
                <span className="mono text-11 text-dim">{timeline.length} months</span>
              ) : null}
            </div>
            {points.length ? (
              <AreaChart points={points} color="var(--color-primary)" />
            ) : (
              <EmptyState icon={CalendarClock} title="No activity recorded" hint="This index has no modified-time data yet." />
            )}
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* Age distribution */}
            <Card className="be-rise be-d2 p-4">
              <SectionLabel className="mb-3">File age distribution</SectionLabel>
              <DistBars buckets={ageBuckets} height={150} />
            </Card>

            {/* Insights */}
            {insights.length ? (
              <Card className="be-rise be-d2 p-4">
                <SectionLabel className="mb-3">Insights</SectionLabel>
                <div className="flex flex-col gap-2.5">
                  {insights.map(({ key, icon: Icon, tint, body }) => (
                    <div key={key} className="flex items-center gap-3">
                      <span
                        className="flex h-7 w-7 flex-none items-center justify-center rounded-lg"
                        style={{ background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint }}
                      >
                        <Icon size={13} strokeWidth={2} aria-hidden />
                      </span>
                      <p className="m-0 text-115 leading-relaxed text-muted">{body}</p>
                    </div>
                  ))}
                </div>
              </Card>
            ) : null}
          </div>

          {/* Large & untouched */}
          {staleFiles.length ? (
            <Card className="be-rise be-d3 p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <SectionLabel>Large &amp; untouched</SectionLabel>
                <span className="mono text-11 text-dim">1 yr+ old · by size</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {staleFiles.map((f) => {
                  const cat = categoryOf(f.media_kind);
                  const CatIcon = cat.icon;
                  const name = lastSegment(f.path);
                  const staged = isStaged(f.path);
                  const days = Math.floor((now - (f.modified_at ?? now)) / DAY);
                  return (
                    <div
                      key={f.path}
                      className="group flex cursor-pointer items-center gap-3 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-window"
                      onClick={() => select({ kind: "file", path: f.path, name, bytes: f.size })}
                    >
                      <span
                        className="flex h-8 w-8 flex-none items-center justify-center rounded-lg"
                        style={{ background: `color-mix(in srgb, ${cat.color} 13%, transparent)`, color: cat.color }}
                      >
                        <CatIcon size={14} strokeWidth={2} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-125 text-ink-soft">{name}</div>
                        <div className="mono truncate text-10 text-faint">{f.path}</div>
                      </div>
                      <span
                        className="mono flex-none text-10 text-dim"
                        title={`${formatCount(days)} days`}
                      >
                        {formatAge(days)}
                      </span>
                      <span className="mono w-16 flex-none text-right text-11 font-medium text-muted">
                        {formatBytes(f.size)}
                      </span>
                      <Button
                        size="sm"
                        variant={staged ? "subtle" : "ghost"}
                        icon={staged ? Check : Plus}
                        className="flex-none"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleStaged({
                            path: f.path,
                            name,
                            bytes: f.size,
                            reason: "stale 1yr+",
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
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
