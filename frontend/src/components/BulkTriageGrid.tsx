import { useMemo } from "react";
import { formatBytes, formatCount } from "../domain";
import { truncatePath } from "../utils/pathUtils";
import type { ScanState } from "../domain";

type DuplicateCandidate = ScanState["duplicateCandidates"][number];

interface BulkTriageGridProps {
  duplicateCandidates: DuplicateCandidate[];
  onOpenWorkbench: (candidate: DuplicateCandidate) => void;
}

const SUSPECT = /\b(backup|old|archive|copy|temp)\b/i;

export function BulkTriageGrid({ duplicateCandidates, onOpenWorkbench }: BulkTriageGridProps) {
  const suspectSegments = useMemo(() => {
    const found = new Set<string>();
    for (const candidate of duplicateCandidates) {
      for (const sample of candidate.samples) {
        const match = SUSPECT.exec(sample);
        if (match) found.add(match[0].toLowerCase());
      }
    }
    return Array.from(found);
  }, [duplicateCandidates]);

  return (
    <div className="flex flex-col">
      {suspectSegments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-primary/10 py-3">
          <span className="font-mono text-10 uppercase text-muted">Smart Rules:</span>
          {suspectSegments.map((segment) => (
            <span
              key={segment}
              className="border border-amber-400/30 px-2.5 py-1 font-mono text-10 uppercase text-amber-400/70"
            >
              {segment} rows highlighted below - open workbench to stage
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[2fr_1fr_60px_100px_80px] gap-3 border-b border-primary/10 py-2 font-mono text-10 uppercase text-muted">
        <span>Sample name</span>
        <span>Size/copy</span>
        <span>Copies</span>
        <span>Reclaimable</span>
        <span />
      </div>

      <div className="flex flex-col">
        {duplicateCandidates.map((candidate, idx) => {
          const sampleName = candidate.samples[0] ?? "-";
          const isSuspect = SUSPECT.test(sampleName);

          return (
            <div
              key={candidate.id ?? `size-${candidate.size}-${idx}`}
              className={`grid grid-cols-[2fr_1fr_60px_100px_80px] items-center gap-3 border-b border-primary/[0.07] py-2 ${isSuspect ? "bg-amber-400/[0.04]" : ""}`}
            >
              <span
                className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11 text-primary"
                title={sampleName}
              >
                {truncatePath(sampleName)}
                {isSuspect && <span className="ml-2 font-mono text-10 text-amber-400/70">!</span>}
              </span>
              <span className="font-mono text-11 text-muted">{formatBytes(candidate.size)}</span>
              <span className="font-mono text-11 text-muted">{formatCount(candidate.files)}</span>
              <span className="font-mono text-11 text-primary">
                {formatBytes(candidate.reclaimableBytes)}
              </span>
              <button
                type="button"
                onClick={() => onOpenWorkbench(candidate)}
                className="border border-white/15 px-2 py-1 font-mono text-10 uppercase text-muted hover:border-white/30 hover:text-primary"
              >
                Open
              </button>
            </div>
          );
        })}
      </div>

      {suspectSegments.length > 0 && (
        <p className="mt-3 font-mono text-10 text-muted/50">
          Highlighted rows contain backup/archive keywords. Open the workbench to review and stage.
        </p>
      )}
    </div>
  );
}
