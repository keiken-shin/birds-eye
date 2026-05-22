import { useState } from "react";
import { Trash2 } from "lucide-react";
import { formatBytes } from "../domain";
import { SmartMovesPanel } from "./SmartMovesPanel";
import type { NativeDuplicateFile } from "../nativeClient";

type Tab = "queue" | "moves";

interface AuditQueueProps {
  staged: Map<string, NativeDuplicateFile>;
  stagedBytes: number;
  unstage: (path: string) => void;
  trashStaged: () => Promise<void>;
  duplicateFiles: NativeDuplicateFile[];
}

export function AuditQueue({ staged, stagedBytes, unstage, trashStaged, duplicateFiles }: AuditQueueProps) {
  const [activeTab, setActiveTab] = useState<Tab>("queue");
  const [showConfidence, setShowConfidence] = useState(false);
  const entries = Array.from(staged.values());

  return (
    <div className="flex w-[220px] shrink-0 flex-col border-l border-primary/15">
      {/* Tab bar */}
      <div className="flex border-b border-primary/15">
        <TabButton label="Audit Queue" active={activeTab === "queue"} onClick={() => setActiveTab("queue")} />
        <TabButton label="Smart Moves" active={activeTab === "moves"} onClick={() => setActiveTab("moves")} />
      </div>

      {activeTab === "queue" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Scrollable area */}
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {/* Confidence explained block */}
            <div>
              <button
                type="button"
                onClick={() => setShowConfidence((v) => !v)}
                className="flex w-full items-center gap-1 font-mono text-10 uppercase text-muted hover:text-primary"
              >
                <span>{showConfidence ? "▾" : "▸"}</span>
                <span>Confidence explained</span>
              </button>
              {showConfidence && (
                <div className="mt-2 border border-white/10 p-2">
                  <table className="w-full border-collapse text-10 text-muted">
                    <tbody>
                      <tr className="border-b border-white/10">
                        <td className="py-1 pr-2 font-mono font-black text-primary">Size match</td>
                        <td className="py-1 leading-snug">Equal byte count. Fast but not conclusive.</td>
                      </tr>
                      <tr className="border-b border-white/10">
                        <td className="py-1 pr-2 font-mono font-black text-primary">Sample hash</td>
                        <td className="py-1 leading-snug">File chunk hashed. High confidence.</td>
                      </tr>
                      <tr>
                        <td className="py-1 pr-2 font-mono font-black text-primary">Full XXH3</td>
                        <td className="py-1 leading-snug">Full content verified. Safe to delete.</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <h3 className="font-mono text-11 font-black uppercase text-muted">Staged for Trash</h3>

            {entries.length === 0 ? (
              <p className="text-12 text-muted/50">
                Stage copies from the comparison panel to queue them here.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
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
          </div>

          {/* Sticky footer — always visible */}
          <div className="shrink-0 border-t border-primary/15 p-3">
            <p className="mb-2 font-mono text-11 font-black text-primary">
              {formatBytes(stagedBytes)} recoverable
            </p>
            <button
              type="button"
              disabled={entries.length === 0}
              onClick={() => void trashStaged()}
              className="flex w-full items-center justify-center gap-2 border border-white/20 py-2.5 font-mono text-11 uppercase text-primary transition-colors hover:border-primary/50 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <Trash2 size={12} />
              {entries.length > 0
                ? `Move ${formatBytes(stagedBytes)} to System Trash`
                : "Move to Trash"}
            </button>
            <p className="mt-1.5 text-center font-mono text-10 text-muted">
              Uses system Trash · recoverable
            </p>
          </div>
        </div>
      ) : (
        <SmartMovesPanel duplicateFiles={duplicateFiles} />
      )}
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={tabButtonClass(active)}
    >
      {label}
    </button>
  );
}

function tabButtonClass(active: boolean): string {
  const base = "flex-1 border-r border-primary/15 py-2 font-mono text-10 uppercase last:border-r-0";
  return active
    ? `${base} bg-primary/10 text-primary`
    : `${base} text-muted hover:text-primary`;
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
