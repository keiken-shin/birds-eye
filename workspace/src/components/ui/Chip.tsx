import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Verdict } from "../../state/types";

export type ChipProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  icon?: LucideIcon;
  /** Category/status dot color (CSS color or var()). */
  dot?: string;
  children: ReactNode;
};

/** Selectable pill — filters, saved views, history. */
export function Chip({ active = false, icon: Icon, dot, children, className = "", ...rest }: ChipProps) {
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-11 transition-colors ${
        active
          ? "border-primary-edge bg-primary-dim text-primary-ink"
          : "border-line-modal text-muted hover:border-line-strong hover:text-ink"
      } ${className}`}
      {...rest}
    >
      {dot ? <span className="h-2 w-2 rounded-full" style={{ background: dot }} aria-hidden /> : null}
      {Icon ? <Icon size={11} strokeWidth={2} aria-hidden /> : null}
      {children}
    </button>
  );
}

const VERDICT_TAG: Record<Verdict, { cls: string; label: string }> = {
  safe: { cls: "bg-safe-bg border-safe-bd text-safe-tx", label: "SAFE" },
  review: { cls: "bg-review-bg border-review-bd text-review-tx", label: "REVIEW" },
  protected: { cls: "bg-protected-bg border-protected-bd text-protected-tx", label: "PROTECTED" },
  keep: { cls: "bg-keep-bg border-keep-bd text-keep-tx", label: "KEEP" },
};

/** Small uppercase verdict/status tag. */
export function VerdictTag({ verdict, label }: { verdict: Verdict; label?: string }) {
  const style = VERDICT_TAG[verdict];
  return (
    <span
      className={`inline-flex items-center rounded-[5px] border px-1.5 py-0.5 text-9 font-semibold tracking-[0.08em] ${style.cls}`}
    >
      {label ?? style.label}
    </span>
  );
}

/** Generic mini tag for non-verdict statuses. */
export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "red" | "blue";
}) {
  const tones: Record<string, string> = {
    neutral: "border-line-modal text-faint",
    green: "border-primary-edge text-primary-ink bg-primary-wash",
    amber: "border-protected-bd text-protected-tx bg-protected-bg",
    red: "border-danger/40 text-danger",
    blue: "border-history/40 text-history",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-9 font-semibold tracking-[0.08em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** Keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="mono rounded border border-line-input bg-inset px-1 py-0.5 text-9 text-label">
      {children}
    </kbd>
  );
}
