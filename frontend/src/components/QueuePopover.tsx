import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { useNavigate } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import { formatBytes, formatCount } from "../domain";
import type { QueueItem } from "../domain";

const mono = "font-mono text-[11px] uppercase";

export function QueuePopover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const { queueItems, loadQueueItem } = useScanContext();
  const navigate = useNavigate();

  // Close on outside click
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleLoad = useCallback(
    async (id: string) => {
      await loadQueueItem(id);
      navigate("/workspace");
      setOpen(false);
    },
    [loadQueueItem, navigate]
  );

  return (
    <div className="relative" ref={triggerRef}>
      <div onClick={() => setOpen((v) => !v)}>{children}</div>
      {open && (
        <div
          ref={panelRef}
          className="absolute bottom-[calc(100%+10px)] right-0 w-[340px] border border-white/12 bg-[#0d0f11] shadow-[0_-8px_32px_rgba(0,0,0,0.6)]"
          role="dialog"
          aria-label="Scan queue"
        >
          <div className="flex items-center justify-between border-b border-white/7 px-[14px] py-[10px]">
            <span className={`${mono} tracking-[2px] text-white/50`}>Scan Queue</span>
            <span className={`${mono} text-white/20`}>{queueItems.length} items</span>
          </div>

          {queueItems.length === 0 && (
            <div className="px-[14px] py-5 text-center">
              <span className={`${mono} text-white/20`}>No scans in queue</span>
            </div>
          )}

          {queueItems.map((item) => (
            <QueueItemRow key={item.id} item={item} onLoad={handleLoad} />
          ))}

          <div className="border-t border-white/5 px-[14px] py-2">
            <span className={`${mono} text-white/15`}>Completed scans saved to Library</span>
          </div>
        </div>
      )}
    </div>
  );
}

function QueueItemRow({
  item,
  onLoad,
}: {
  item: QueueItem;
  onLoad: (id: string) => void;
}) {
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (item.status !== "loaded") return;
    const interval = setInterval(() => {
      setCountdown((n) => Math.max(0, n - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [item.status]);

  const dotColor =
    item.status === "scanning"
      ? "bg-[#00d0c4] animate-pulse shadow-[0_0_6px_#00d0c4]"
      : item.status === "done"
      ? "bg-[#b7ff5c]"
      : "bg-white/20";

  return (
    <div
      className={`border-b border-white/5 px-[14px] py-[10px] transition-opacity ${
        item.status === "loaded" ? "opacity-45" : ""
      }`}
    >
      <div className="mb-[6px] flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <div className={`h-[6px] w-[6px] shrink-0 rounded-full ${dotColor}`} />
          <span
            className={`truncate text-[10px] font-black text-[#f4f1ea] ${
              item.status === "loaded" ? "line-through" : ""
            }`}
          >
            {item.rootName}
          </span>
        </div>
        {item.status === "scanning" && (
          <span className={`${mono} shrink-0 text-[#00d0c4]`}>scanning</span>
        )}
        {item.status === "done" && (
          <span className={`${mono} shrink-0 text-[#b7ff5c]`}>done</span>
        )}
        {item.status === "loaded" && (
          <span className={`${mono} shrink-0 text-white/30`}>loaded ✓</span>
        )}
      </div>

      {item.status === "scanning" && (
        <>
          <div className="mb-1 h-[2px] bg-white/6">
            <div className="h-full bg-[#00d0c4]" style={{ width: `${item.progress}%` }} />
          </div>
          <span className={`${mono} text-white/30`}>{item.progress}%</span>
        </>
      )}

      {item.status === "done" && (
        <div className="flex items-center justify-between">
          <span className={`${mono} text-white/30`}>
            {item.totalFiles ? formatCount(item.totalFiles) : "—"} files
            {item.totalBytes ? ` · ${formatBytes(item.totalBytes)}` : ""}
          </span>
          <button
            className="border border-[#b7ff5c]/30 bg-[#b7ff5c]/10 px-[10px] py-[3px] font-mono text-[9px] font-black uppercase tracking-[1px] text-[#b7ff5c]"
            type="button"
            onClick={() => onLoad(item.id)}
          >
            Load →
          </button>
        </div>
      )}

      {item.status === "loaded" && (
        <span className={`${mono} text-white/20`}>removing in {countdown}s…</span>
      )}
    </div>
  );
}
