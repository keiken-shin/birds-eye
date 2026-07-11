import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button, type ButtonProps } from "./Button";

/** Standard panel card. */
export function Card({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`rounded-xl border border-line bg-inset ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** Uppercase tracked section kicker — the one label style everywhere. */
export function SectionLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`text-10 font-semibold tracking-[0.12em] text-label uppercase ${className}`}>
      {children}
    </div>
  );
}

/** Count-up over ~0.9s, cubic ease-out. Respects prefers-reduced-motion. */
export function useCountUp(target: number, deps: unknown[] = []) {
  const [value, setValue] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const dur = 900;
    const tick = (now: number) => {
      // rAF timestamps can precede the performance.now() captured above — clamp
      // so the eased value never goes negative (formatBytes(negative) → NaN).
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(target * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ...deps]);
  return value;
}

export type StatCardProps = {
  label: string;
  value: string;
  icon: LucideIcon;
  /** Icon tile color (CSS color or var()). */
  tint?: string;
  sub?: ReactNode;
  onClick?: () => void;
};

/** Dashboard stat tile: icon tile + big mono value + label. */
export function StatCard({ label, value, icon: Icon, tint = "var(--color-primary)", sub, onClick }: StatCardProps) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      className={`group relative overflow-hidden rounded-xl border border-line bg-inset p-3.5 text-left transition-colors ${
        onClick ? "hover:border-line-strong" : ""
      }`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -top-5 -right-5 h-16 w-16 rounded-full opacity-15 blur-2xl"
        style={{ background: tint }}
      />
      <span
        className="mb-2.5 inline-flex h-8 w-8 items-center justify-center rounded-lg"
        style={{ background: `color-mix(in srgb, ${tint} 13%, transparent)`, color: tint }}
      >
        <Icon size={15} strokeWidth={2} aria-hidden />
      </span>
      <div className="mono text-[19px] leading-none font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-1.5 text-105 tracking-[0.08em] text-label uppercase">{label}</div>
      {sub ? <div className="mt-1 text-11 text-faint">{sub}</div> : null}
    </Comp>
  );
}

/** Thin horizontal meter (storage usage, group waste, distribution cells). */
export function Meter({
  fraction,
  color = "var(--color-primary)",
  track = "var(--color-raised)",
  height = 6,
  className = "",
}: {
  fraction: number;
  color?: string;
  track?: string;
  height?: number;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className={`w-full overflow-hidden rounded-full ${className}`} style={{ height, background: track }}>
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
  action?: ButtonProps & { label: string };
  className?: string;
};

/** Shared empty state: quiet icon, one-line title, optional hint + action. */
export function EmptyState({ icon: Icon, title, hint, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center gap-2 p-8 text-center ${className}`}>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-inset text-label">
        <Icon size={19} strokeWidth={1.75} aria-hidden />
      </span>
      <div className="text-125 font-medium text-ink-soft">{title}</div>
      {hint ? <div className="max-w-90 text-11 leading-relaxed text-faint">{hint}</div> : null}
      {action ? (
        <Button variant="subtle" size="sm" className="mt-1" {...action}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
