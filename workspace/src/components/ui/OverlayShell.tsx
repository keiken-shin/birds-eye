import type { ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "./Button";

export type OverlayShellProps = {
  title: string;
  /** Small mono meta text next to the title (counts, totals). */
  meta?: ReactNode;
  onClose: () => void;
  /** Panel width in px (height grows to fit, capped at 82vh). */
  width?: number;
  /** When true, backdrop clicks do not close (mid-flight destructive work). */
  locked?: boolean;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * The one modal shell: dimmed blurred backdrop, centered panel, standard
 * header (title · meta · close) and optional pinned footer.
 */
export function OverlayShell({
  title,
  meta,
  onClose,
  width = 560,
  locked = false,
  children,
  footer,
}: OverlayShellProps) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,0.66)] backdrop-blur-[3px]"
      onClick={() => {
        if (!locked) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={title}
        className="be-in flex max-h-[82vh] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)]"
        style={{ width }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4.5 py-3.5">
          <div className="text-15 font-semibold text-ink">{title}</div>
          {meta ? <div className="mono text-11 text-dim">{meta}</div> : null}
          <IconButton icon={X} label="Close" size={15} className="ml-auto" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer ? <div className="border-t border-line px-4.5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
