import { formatBytes } from "../domain";
import type { TrashProgress as TrashProgressState } from "../hooks/useAuditQueue";

interface TrashProgressProps {
  progress: TrashProgressState;
  onDismiss: () => void;
}

export function TrashProgress({ progress, onDismiss }: TrashProgressProps) {
  const { status, total, completed, failedCount, bytesCleared, log } = progress;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const isDone = status === "done";
  const hasFailures = failedCount > 0;

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 font-mono">
      <div className="border-b border-primary/10 pb-3">
        <p className="text-11 font-black uppercase text-primary">
          {isDone
            ? hasFailures
              ? `Purge Finished - ${failedCount} Failed`
              : "Purge Complete"
            : `Purging - ${completed}/${total} Files`}
        </p>
        <p className="mt-1 text-10 text-muted">{formatBytes(bytesCleared)} cleared</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="h-1.5 w-full bg-white/10">
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-right text-10 text-muted">{pct}%</p>
      </div>

      <div className="flex flex-1 flex-col gap-1 overflow-hidden">
        <p className="text-10 uppercase text-muted/60">Log</p>
        <div className="flex flex-1 flex-col-reverse gap-0.5 overflow-y-auto">
          {log.map((path, idx) => (
            <p
              key={path}
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-10"
              style={{ opacity: Math.max(0.25, 1 - idx * 0.07) }}
            >
              {path}
            </p>
          ))}
        </div>
      </div>

      {isDone && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 border border-white/20 py-2 text-11 uppercase text-primary hover:border-primary/50 hover:bg-primary/10"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
