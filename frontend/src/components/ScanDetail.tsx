import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Pause, Play, Square, Trash2, ChevronRight } from "lucide-react";
import { useScanContext } from "../context/ScanContext";
import { ScanMetrics } from "./ScanMetrics";
import { ScanLog } from "./ScanLog";

interface ScanDetailProps {
  id: string;
}

const iconBtn =
  "grid h-[30px] w-[30px] place-items-center border border-white/15 bg-black/20 text-primary/60 hover:bg-white/10 hover:text-primary";

export function ScanDetail({ id }: ScanDetailProps) {
  const { queueItems, scan, activeQueueId, pauseScan, resumeScan, cancelScan, deleteQueueItem } = useScanContext();
  const navigate = useNavigate();

  const item = queueItems.find((q) => q.id === id);

  // Navigate away if item is removed (cancelled scan)
  useEffect(() => {
    if (!item) navigate("/scan");
  }, [item, navigate]);

  if (!item) return null;

  const isActive = id === activeQueueId;

  // For active scan: use live scan state; for completed: use stored item data
  const processedFiles = isActive ? scan.processedFiles : item.totalFiles ?? 0;
  const totalFiles = isActive ? scan.totalFiles : item.totalFiles ?? 0;
  const processedBytes = isActive ? scan.processedBytes : item.totalBytes ?? 0;
  const foldersCount = isActive ? scan.folders.length : item.foldersScanned ?? 0;
  const elapsedMs = isActive ? scan.elapsedMs : item.elapsedMs ?? 0;
  const progress = item.progress;

  const statusColor =
    item.status === "scanning"
      ? "text-accent"
      : item.status === "done"
      ? "text-success"
      : "text-white/30";

  return (
    <div className="flex flex-1 flex-col min-h-full border-l border-white/0">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-[16px] py-[12px] gap-3">
        <div className="flex items-center gap-[10px] min-w-0">
          <span className="truncate text-13 font-black uppercase text-primary">{item.rootName}</span>
          <span className={`font-mono text-10 uppercase shrink-0 ${statusColor}`}>{item.status}</span>
        </div>
        <div className="flex items-center gap-[6px] shrink-0">
          {isActive && scan.status === "scanning" && (
            <>
              <button className={iconBtn} type="button" onClick={pauseScan} title="Pause scan">
                <Pause size={13} />
              </button>
              <button className={`${iconBtn} hover:text-danger`} type="button" onClick={cancelScan} title="Stop scan">
                <Square size={13} />
              </button>
            </>
          )}
          {isActive && scan.status === "paused" && (
            <>
              <button className={iconBtn} type="button" onClick={resumeScan} title="Resume scan">
                <Play size={13} />
              </button>
              <button className={`${iconBtn} hover:text-danger`} type="button" onClick={cancelScan} title="Stop scan">
                <Square size={13} />
              </button>
            </>
          )}
          {(item.status === "done" || item.status === "loaded") && (
            <button
              className="flex items-center gap-1.5 border border-danger/20 px-2 py-1 font-mono text-9 font-black uppercase tracking-[1px] text-danger/50 hover:border-danger/50 hover:text-danger"
              type="button"
              onClick={() => {
                deleteQueueItem(id);
                navigate("/scan");
              }}
              title="Delete scan record"
            >
              <Trash2 size={10} />
              Delete
            </button>
          )}
          <button
            className={iconBtn}
            type="button"
            onClick={() => navigate("/scan")}
            title="Collapse detail panel"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-[3px] bg-white/6">
        <div
          className={`h-full transition-all ${item.status === "scanning" ? "bg-accent" : "bg-success"}`}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Metrics */}
      <ScanMetrics
        processedFiles={processedFiles}
        totalFiles={totalFiles}
        processedBytes={processedBytes}
        foldersCount={foldersCount}
        elapsedMs={elapsedMs}
      />

      {/* Log */}
      <div className="flex-1 flex flex-col border-t border-white/8 min-h-0">
        <ScanLog entries={item.logs} isActive={item.status === "scanning"} />
      </div>
    </div>
  );
}


