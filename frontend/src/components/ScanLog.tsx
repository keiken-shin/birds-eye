import { useEffect, useRef, useState } from "react";
import type { ScanLogEntry } from "../domain";

interface ScanLogProps {
  entries: ScanLogEntry[];
  isActive: boolean;
}

export function ScanLog({ entries, isActive }: ScanLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView?.({ behavior: "smooth" });
    }
  }, [entries, autoScroll]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 16;
    setAutoScroll(atBottom);
  }

  // Resume auto-scroll when scan becomes active again
  useEffect(() => {
    if (isActive) setAutoScroll(true);
  }, [isActive]);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center justify-between border-b border-white/8 px-[14px] py-[8px]">
        <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-white/30">Log</span>
        {!autoScroll && (
          <button
            className="font-mono text-[9px] uppercase text-[#00d0c4]/60 hover:text-[#00d0c4]"
            type="button"
            onClick={() => {
              setAutoScroll(true);
              bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
            }}
          >
            ↓ resume scroll
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-black/40 px-[14px] py-[10px] font-mono text-[11px]"
        style={{ minHeight: "180px", maxHeight: "320px" }}
      >
        {entries.length === 0 ? (
          <span className="text-white/15 uppercase">No log entries yet</span>
        ) : (
          entries.map((entry, i) => (
            <LogLine key={`${entry.ts}-${i}`} entry={entry} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: ScanLogEntry }) {
  const time = new Date(entry.ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const levelColor =
    entry.level === "error"
      ? "text-[#ff6b6b]"
      : entry.level === "warn"
      ? "text-[#f5c842]"
      : "text-white/25";

  const messageColor =
    entry.level === "error"
      ? "text-[#ff6b6b]/80"
      : entry.level === "warn"
      ? "text-[#f5c842]/70"
      : "text-white/45";

  return (
    <div className="flex items-baseline gap-[10px] py-[2px]">
      <span className="shrink-0 text-white/15">{time}</span>
      <span className={`shrink-0 w-[36px] ${levelColor}`}>{entry.level}</span>
      <span className={`break-all ${messageColor}`}>{entry.message}</span>
    </div>
  );
}
