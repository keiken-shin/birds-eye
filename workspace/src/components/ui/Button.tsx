import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type Variant = "primary" | "ghost" | "subtle" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-on-primary font-semibold hover:brightness-110 disabled:bg-raised disabled:text-label",
  ghost:
    "border border-line-modal text-muted hover:text-ink hover:border-line-strong disabled:text-label",
  subtle:
    "bg-primary-dim text-primary-ink border border-primary-edge hover:brightness-125 disabled:opacity-50",
  danger:
    "border border-line-modal text-muted hover:text-danger hover:border-danger/50 disabled:text-label",
};

const SIZES: Record<Size, string> = {
  sm: "text-11 px-2.5 py-1 gap-1 rounded-md",
  md: "text-125 px-3.5 py-2 gap-1.5 rounded-lg",
};

const ICON_SIZE: Record<Size, number> = { sm: 12, md: 14 };

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  children?: ReactNode;
};

export function Button({
  variant = "ghost",
  size = "md",
  icon: Icon,
  children,
  className = "",
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center transition-colors ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {Icon ? <Icon size={ICON_SIZE[size]} strokeWidth={2} aria-hidden /> : null}
      {children}
    </button>
  );
}

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  /** Accessible name — also shown as the native tooltip. */
  label: string;
  active?: boolean;
  size?: number;
};

/** Square icon-only button (rails, card corners, list rows). */
export function IconButton({
  icon: Icon,
  label,
  active = false,
  size = 15,
  className = "",
  ...rest
}: IconButtonProps) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center rounded-lg p-1.5 transition-colors ${
        active
          ? "bg-primary-dim text-primary border border-primary-edge"
          : "border border-transparent text-faint hover:bg-inset hover:text-ink"
      } ${className}`}
      {...rest}
    >
      <Icon size={size} strokeWidth={2} aria-hidden />
    </button>
  );
}
