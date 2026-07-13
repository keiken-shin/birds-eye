import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes } from "@bridge/domain";

/* ------------------------------------------------------------------ */
/* Shared tooltip                                                      */
/* ------------------------------------------------------------------ */

type TipState = { x: number; y: number; body: ReactNode } | null;

function Tip({ tip }: { tip: TipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  // Clamp inside the positioning container so hovering near the right edge
  // never widens the page into a horizontal scroll.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const parent = el.offsetParent as HTMLElement | null;
    if (!parent) return;
    const over = tip.x + 12 + el.offsetWidth - parent.clientWidth;
    setShift(over > 0 ? over : 0);
  }, [tip]);
  if (!tip) return null;
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-10 rounded-lg border border-line-modal bg-overlay px-2.5 py-1.5 whitespace-nowrap shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
      style={{ left: Math.max(0, tip.x + 12 - shift), top: tip.y + 12 }}
    >
      {tip.body}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Donut                                                               */
/* ------------------------------------------------------------------ */

export type Segment = {
  key: string;
  label: string;
  value: number;
  color: string;
};

export function Donut({
  segments,
  size = 168,
  thickness = 26,
  center,
}: {
  segments: Segment[];
  size?: number;
  thickness?: number;
  center?: { value: string; label: string };
}) {
  const [tip, setTip] = useState<TipState>(null);
  const [hot, setHot] = useState<string | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  // 2px surface gap between segments, honored as arc-length padding.
  const gap = segments.length > 1 ? 2.5 : 0;

  let offset = 0;
  const arcs = segments.map((seg) => {
    const frac = total > 0 ? seg.value / total : 0;
    const len = Math.max(0, frac * circumference - gap);
    const arc = { seg, frac, dasharray: `${len} ${circumference - len}`, dashoffset: -offset };
    offset += frac * circumference;
    return arc;
  });

  return (
    <div className="relative inline-flex items-center justify-center" onMouseLeave={() => { setTip(null); setHot(null); }}>
      <svg width={size} height={size} role="img" aria-label="Category composition">
        <g transform={`rotate(-90 ${c} ${c})`}>
          {arcs.map(({ seg, dasharray, dashoffset }) => (
            <circle
              key={seg.key}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={hot === seg.key ? thickness + 4 : thickness}
              strokeDasharray={dasharray}
              strokeDashoffset={dashoffset}
              opacity={hot && hot !== seg.key ? 0.35 : 1}
              style={{ transition: "stroke-width 0.12s, opacity 0.12s" }}
              onMouseMove={(e) => {
                const box = e.currentTarget.closest("div")!.getBoundingClientRect();
                setHot(seg.key);
                setTip({
                  x: e.clientX - box.left,
                  y: e.clientY - box.top,
                  body: (
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: seg.color }} />
                      <span className="text-11 text-ink-soft">{seg.label}</span>
                      <span className="mono text-11 font-semibold text-ink">{formatBytes(seg.value)}</span>
                      <span className="text-10 text-faint">{total ? Math.round((seg.value / total) * 100) : 0}%</span>
                    </div>
                  ),
                });
              }}
            />
          ))}
        </g>
      </svg>
      {center ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="mono text-[17px] font-semibold text-ink">{center.value}</div>
          <div className="text-10 tracking-[0.08em] text-label uppercase">{center.label}</div>
        </div>
      ) : null}
      <Tip tip={tip} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stacked category bar (the macOS-storage-style capacity bar)         */
/* ------------------------------------------------------------------ */

export function CategoryBar({
  segments,
  height = 14,
  className = "",
}: {
  segments: Segment[];
  height?: number;
  className?: string;
}) {
  const [tip, setTip] = useState<TipState>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className={`relative ${className}`} onMouseLeave={() => setTip(null)}>
      <div className="flex w-full gap-[2px] overflow-hidden rounded-md" style={{ height }}>
        {segments.map((seg) => {
          const frac = total > 0 ? seg.value / total : 0;
          if (frac <= 0) return null;
          return (
            <div
              key={seg.key}
              className="h-full min-w-[3px] transition-[filter]"
              style={{ width: `${frac * 100}%`, background: seg.color }}
              onMouseMove={(e) => {
                const box = e.currentTarget.parentElement!.parentElement!.getBoundingClientRect();
                setTip({
                  x: e.clientX - box.left,
                  y: e.clientY - box.top,
                  body: (
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: seg.color }} />
                      <span className="text-11 text-ink-soft">{seg.label}</span>
                      <span className="mono text-11 font-semibold text-ink">{formatBytes(seg.value)}</span>
                    </div>
                  ),
                });
              }}
            />
          );
        })}
      </div>
      <Tip tip={tip} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Horizontal bar list (top consumers / extensions)                    */
/* ------------------------------------------------------------------ */

export type BarRow = {
  key: string;
  label: ReactNode;
  value: number;
  color?: string;
  /** Right-aligned value text; defaults to formatBytes(value). */
  display?: string;
  onClick?: () => void;
};

export function BarList({ rows, max }: { rows: BarRow[]; max?: number }) {
  const top = max ?? rows.reduce((m, r) => Math.max(m, r.value), 0);
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => {
        const Comp = row.onClick ? "button" : "div";
        return (
          <Comp
            key={row.key}
            onClick={row.onClick}
            className={`group grid grid-cols-[minmax(0,1fr)_72px] items-center gap-2 rounded-md px-1 py-0.5 text-left ${
              row.onClick ? "hover:bg-inset" : ""
            }`}
          >
            <div className="min-w-0">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-115 text-ink-soft">{row.label}</span>
              </div>
              <div className="h-[5px] w-full overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{
                    width: `${top > 0 ? Math.max(1.5, (row.value / top) * 100) : 0}%`,
                    background: row.color ?? "var(--color-primary)",
                  }}
                />
              </div>
            </div>
            <span className="mono text-right text-11 text-muted">
              {row.display ?? formatBytes(row.value)}
            </span>
          </Comp>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Area chart (monthly activity timeline)                              */
/* ------------------------------------------------------------------ */

export type AreaPoint = { label: string; value: number; meta?: string };

export function AreaChart({
  points,
  height = 150,
  color = "var(--color-primary)",
  formatValue = formatBytes,
}: {
  points: AreaPoint[];
  height?: number;
  color?: string;
  formatValue?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const PAD = { t: 10, r: 8, b: 20, l: 8 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const max = Math.max(1, ...points.map((p) => p.value));

  const coords = useMemo(
    () =>
      points.map((p, i) => ({
        x: PAD.l + (points.length > 1 ? (i / (points.length - 1)) * innerW : innerW / 2),
        y: PAD.t + innerH - (p.value / max) * innerH,
      })),
    [points, innerW, innerH, max]
  );

  if (!points.length) return null;

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1].x},${PAD.t + innerH} L${coords[0].x},${PAD.t + innerH} Z`;
  const gridYs = [0.25, 0.5, 0.75].map((f) => PAD.t + innerH * f);
  // Label every ~6th tick to keep the axis quiet.
  const step = Math.max(1, Math.ceil(points.length / 6));

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full"
        role="img"
        aria-label="Activity over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          let bestD = Infinity;
          coords.forEach((c, i) => {
            const d = Math.abs(c.x - x);
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          });
          setHover(best);
        }}
      >
        {gridYs.map((y) => (
          <line key={y} x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="var(--color-grid)" strokeWidth={1} />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH} stroke="var(--color-axis)" strokeWidth={1} />
        <path d={area} fill={color} opacity={0.09} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) =>
          i % step === 0 ? (
            <text
              key={i}
              x={coords[i].x}
              y={H - 5}
              textAnchor="middle"
              className="fill-[var(--color-label)]"
              fontSize={9}
              fontFamily="var(--font-mono)"
            >
              {p.label}
            </text>
          ) : null
        )}
        {hover !== null ? (
          <g>
            <line
              x1={coords[hover].x}
              x2={coords[hover].x}
              y1={PAD.t}
              y2={PAD.t + innerH}
              stroke="var(--color-line-strong)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <circle cx={coords[hover].x} cy={coords[hover].y} r={4} fill={color} stroke="var(--color-window)" strokeWidth={2} />
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <div
          className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-lg border border-line-modal bg-overlay px-2.5 py-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
          style={{ left: `${(coords[hover].x / W) * 100}%` }}
        >
          <div className="text-10 whitespace-nowrap text-faint">{points[hover].meta ?? points[hover].label}</div>
          <div className="mono text-115 font-semibold text-ink">{formatValue(points[hover].value)}</div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Distribution bars (age buckets)                                     */
/* ------------------------------------------------------------------ */

export type DistBucket = { key: string; label: string; value: number; color: string; meta?: string };

export function DistBars({
  buckets,
  height = 120,
  formatValue = formatBytes,
}: {
  buckets: DistBucket[];
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const [hot, setHot] = useState<string | null>(null);
  const max = Math.max(1, ...buckets.map((b) => b.value));
  return (
    <div className="flex items-end gap-2" style={{ height }} onMouseLeave={() => setHot(null)}>
      {buckets.map((b) => {
        const h = Math.max(4, (b.value / max) * (height - 34));
        return (
          <div key={b.key} className="group relative flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            {hot === b.key ? (
              <div className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-lg border border-line-modal bg-overlay px-2.5 py-1.5 whitespace-nowrap shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
                <div className="text-10 text-faint">{b.meta ?? b.label}</div>
                <div className="mono text-115 font-semibold text-ink">{formatValue(b.value)}</div>
              </div>
            ) : null}
            <div
              className="w-full max-w-11 rounded-t-[4px] transition-[filter]"
              style={{ height: h, background: b.color, filter: hot === b.key ? "brightness(1.3)" : undefined }}
              onMouseEnter={() => setHot(b.key)}
            />
            <div className="text-9 tracking-wide text-label uppercase">{b.label}</div>
          </div>
        );
      })}
    </div>
  );
}
