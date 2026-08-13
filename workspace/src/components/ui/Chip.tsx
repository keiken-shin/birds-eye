import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { Verdict } from "../../state/types";
import { VERDICT_STYLES } from "../../lib/verdict";

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

/** Colour only — the words live in VERDICT_STYLES so there is one set of them.
 *  `protected` and `keep` share the one grey, same as their shared label. */
const DONT_TOUCH_CLS = "bg-keep-bg border-keep-bd text-keep-tx";
const VERDICT_CLS: Record<Verdict, string> = {
  safe: "bg-safe-bg border-safe-bd text-safe-tx",
  review: "bg-review-bg border-review-bd text-review-tx",
  protected: DONT_TOUCH_CLS,
  keep: DONT_TOUCH_CLS,
};

/** Small safety tag. Three words across four states — `protected` and `keep` read the same. */
export function VerdictTag({ verdict, label }: { verdict: Verdict; label?: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-[5px] border px-1.5 py-0.5 text-9 font-semibold tracking-[0.04em] ${VERDICT_CLS[verdict]}`}
    >
      {label ?? VERDICT_STYLES[verdict].label}
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
    amber: "border-review-bd text-review-tx bg-review-bg",
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
