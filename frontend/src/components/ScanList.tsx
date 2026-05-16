import { Link } from "react-router-dom";
import { useScanContext } from "../context/ScanContext";
import type { QueueItem } from "../domain";

const mono = "font-mono text-[11px] uppercase";

interface ScanListProps {
  selectedId: string | undefined;
}

export function ScanList({ selectedId }: ScanListProps) {
  const { queueItems } = useScanContext();

  return (
    <aside className="w-[260px] shrink-0 border-r border-white/10 flex flex-col min-h-full">
      <div className="border-b border-white/10 px-[16px] py-[12px]">
        <span className={`${mono} tracking-[2px] text-white/40`}>Scan History</span>
      </div>

      {queueItems.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className={`${mono} text-white/20`}>No scans yet</span>
          <Link
            to="/"
            className="border border-white/15 px-4 py-2 font-mono text-[11px] uppercase text-[#f4f1ea] hover:bg-white/5"
          >
            Start Scan
          </Link>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {queueItems.map((item) => (
            <ScanListItem key={item.id} item={item} isSelected={item.id === selectedId} />
          ))}
        </ul>
      )}
    </aside>
  );
}

function ScanListItem({ item, isSelected }: { item: QueueItem; isSelected: boolean }) {
  const dotColor =
    item.status === "scanning"
      ? "bg-[#00d0c4] animate-pulse shadow-[0_0_6px_#00d0c4]"
      : item.status === "done"
      ? "bg-[#b7ff5c]"
      : "bg-white/20";

  const age = item.loadedAt
    ? formatAge(item.loadedAt)
    : item.elapsedMs
    ? `${(item.elapsedMs / 1000).toFixed(1)}s`
    : null;

  return (
    <li>
      <Link
        to={`/scan/${item.id}`}
        className={`flex items-start gap-[10px] border-b border-white/5 px-[16px] py-[12px] transition-colors hover:bg-white/[0.04] ${
          isSelected ? "border-l-2 border-l-[#00d0c4] bg-white/[0.06] pl-[14px]" : "border-l-2 border-l-transparent"
        }`}
      >
        <div className="mt-[4px] shrink-0">
          <div className={`h-[7px] w-[7px] rounded-full ${dotColor}`} />
        </div>
        <div className="min-w-0 flex-1 grid gap-[3px]">
          <span className="truncate text-[12px] font-black uppercase text-[#f4f1ea]">{item.rootName}</span>
          <div className="flex items-center justify-between gap-2">
            <span className={`${mono} text-white/30 capitalize`}>{item.status}</span>
            {age && <span className={`${mono} text-white/20`}>{age}</span>}
          </div>
          {item.status === "scanning" && (
            <div className="mt-[4px] h-[2px] bg-white/8">
              <div className="h-full bg-[#00d0c4]" style={{ width: `${item.progress}%` }} />
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

function formatAge(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
