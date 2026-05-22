import { formatBytes, formatCount } from "../domain";
import { ComparisonPanel } from "./ComparisonPanel";
import { AuditQueue } from "./AuditQueue";
import type { ScanState } from "../domain";
import type { NativeDuplicateFile } from "../nativeClient";

type DuplicateCandidate = ScanState["duplicateCandidates"][number];

interface DuplicateWorkbenchProps {
  duplicateCandidates: ScanState["duplicateCandidates"];
  selectedDuplicateGroup: number | null;
  selectDuplicateCandidate: (candidate: DuplicateCandidate) => void;
  duplicateFiles: NativeDuplicateFile[];
  comparisonCursor: number;
  setComparisonCursor: (n: number) => void;
  staged: Map<string, NativeDuplicateFile>;
  stagedBytes: number;
  stage: (file: NativeDuplicateFile) => void;
  unstage: (path: string) => void;
  trashStaged: () => Promise<void>;
  onCollapse: () => void;
  nativeRuntime: boolean;
}

export function DuplicateWorkbench({
  duplicateCandidates,
  selectedDuplicateGroup,
  selectDuplicateCandidate,
  duplicateFiles,
  comparisonCursor,
  setComparisonCursor,
  staged,
  stagedBytes,
  stage,
  unstage,
  trashStaged,
  onCollapse,
  nativeRuntime,
}: DuplicateWorkbenchProps) {
  return (
    <section className={workbenchClass}>
      {/* Left: group list */}
      <div className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-primary/15 p-4">
        <h3 className="mb-2 font-mono text-11 font-black uppercase text-muted">Duplicate Groups</h3>
        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {duplicateCandidates.map((candidate, idx) => (
            <button
              key={candidate.id ?? `size-${candidate.size}-${idx}`}
              type="button"
              onClick={() => void selectDuplicateCandidate(candidate)}
              className={groupRowClass(selectedDuplicateGroup === candidate.id)}
            >
              <strong className="text-primary">{formatBytes(candidate.reclaimableBytes)}</strong>
              <span className="text-muted text-11">{formatCount(candidate.files)} files · {formatBytes(candidate.size)} each</span>
              <span className="font-mono text-10 text-muted/60">{candidate.samples[0] ?? ""}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onCollapse}
          className="mt-auto border-t border-primary/10 pt-3 text-left font-mono text-11 uppercase text-muted hover:text-primary"
        >
          ← collapse workbench
        </button>
      </div>

      {/* Center: comparison */}
      <ComparisonPanel
        files={duplicateFiles}
        cursor={comparisonCursor}
        setCursor={setComparisonCursor}
        staged={staged}
        stage={stage}
        unstage={unstage}
        nativeRuntime={nativeRuntime}
      />

      {/* Right: audit queue */}
      <AuditQueue
        staged={staged}
        stagedBytes={stagedBytes}
        unstage={unstage}
        trashStaged={trashStaged}
        duplicateFiles={duplicateFiles}
      />
    </section>
  );
}

function groupRowClass(active: boolean): string {
  const base = "flex w-full flex-col items-start gap-0.5 border-b border-primary/10 px-2 py-2.5 text-left";
  return active ? `${base} bg-primary/10` : `${base} hover:bg-primary/[0.055]`;
}

const workbenchClass =
  "relative mt-5 flex min-h-[480px] border border-white/15 bg-white/[0.045] shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
