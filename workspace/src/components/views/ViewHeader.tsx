import type { ReactNode } from "react";

/** Consistent compact header for every stage view: title · subtitle · actions. */
export function ViewHeader({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-12 flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-4 py-1.5">
      <h2 className="text-15 font-semibold tracking-tight text-ink">{title}</h2>
      {sub ? <div className="min-w-0 truncate text-11 text-faint">{sub}</div> : null}
      {actions ? (
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1.5">{actions}</div>
      ) : null}
    </div>
  );
}
