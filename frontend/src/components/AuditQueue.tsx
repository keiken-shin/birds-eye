import { Trash2 } from "lucide-react";
import { formatBytes } from "../domain";
import type { NativeDuplicateFile } from "../nativeClient";

interface AuditQueueProps {
  staged: Map<string, NativeDuplicateFile>;
  stagedBytes: number;
  unstage: (path: string) => void;
  trashStaged: () => Promise<void>;
}

export function AuditQueue({ staged, stagedBytes, unstage, trashStaged }: AuditQueueProps) {
  const entries = Array.from(staged.values());

  return (
    <div className="flex w-[200px] shrink-0 flex-col gap-3 border-l border-primary/15 p-4">
      <h3 className="font-mono text-11 font-black uppercase text-muted">Staged for Trash</h3>

      {entries.length === 0 ? (
        <p className="text-12 text-muted/50">
          Stage copies from the comparison panel to queue them here.
        </p>
      ) : (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
          {entries.map((file) => (
            <div key={file.path} className="border border-white/10 bg-white/[0.02] p-2">
              <p className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-10 text-primary">
                {lastSegment(file.path)}
              </p>
              <p className="mt-0.5 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-10 text-muted">
                {file.path}
              </p>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="font-mono text-10 text-muted">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => unstage(file.path)}
                  className="font-mono text-10 uppercase text-muted hover:text-primary"
                >
                  unstage ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-primary/10 pt-3">
        <p className="font-mono text-11 font-black text-primary">
          {formatBytes(stagedBytes)} recoverable
        </p>
        <button
          type="button"
          disabled={entries.length === 0}
          onClick={() => void trashStaged()}
          className="flex items-center justify-center gap-2 border border-white/20 py-2 font-mono text-11 uppercase text-primary transition-colors hover:border-primary/50 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Trash2 size={12} />
          Move {entries.length} to Trash
        </button>
        <p className="text-center font-mono text-10 text-muted">
          Uses system Trash · recoverable
        </p>
      </div>
    </div>
  );
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
