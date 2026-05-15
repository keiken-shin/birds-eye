import React from "react";

export function ScrollableRows({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return <div className={`${compact ? "max-h-[360px]" : "max-h-[520px]"} overflow-auto pr-1.5 [scrollbar-color:rgba(244,241,234,0.32)_rgba(255,255,255,0.06)] [scrollbar-width:thin]`}>{children}</div>;
}
