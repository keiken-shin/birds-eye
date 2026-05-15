import React from "react";

export function ScrollableRows({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  return <div className={`scroll-rows ${compact ? "compact" : ""}`}>{children}</div>;
}
