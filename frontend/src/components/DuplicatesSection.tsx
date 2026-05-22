import { CopyCheck } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { formatDate } from "../utils/displayUtils";
import { ScrollableRows } from "./ScrollableRows";
import { DuplicateWorkbench } from "./DuplicateWorkbench";
import type { ScanState } from "../domain";
import type { NativeDuplicateFile } from "../nativeClient";

type DuplicateCandidate = ScanState["duplicateCandidates"][number];

interface DuplicatesSectionProps {
  duplicateCandidates: ScanState["duplicateCandidates"];
  selectedDuplicateGroup: number | null;
  selectDuplicateCandidate: (candidate: DuplicateCandidate) => void;
  duplicateFiles: NativeDuplicateFile[];
  onClearSelection: () => void;
  comparisonCursor: number;
  setComparisonCursor: (n: number) => void;
  staged: Map<string, NativeDuplicateFile>;
  stagedBytes: number;
  stage: (file: NativeDuplicateFile) => void;
  unstage: (path: string) => void;
  trashStaged: () => Promise<void>;
}

export function DuplicatesSection({
  duplicateCandidates,
  selectedDuplicateGroup,
  selectDuplicateCandidate,
  duplicateFiles,
  onClearSelection,
  comparisonCursor,
  setComparisonCursor,
  staged,
  stagedBytes,
  stage,
  unstage,
  trashStaged,
}: DuplicatesSectionProps) {
  if (selectedDuplicateGroup !== null) {
    return (
      <DuplicateWorkbench
        duplicateCandidates={duplicateCandidates}
        selectedDuplicateGroup={selectedDuplicateGroup}
        selectDuplicateCandidate={selectDuplicateCandidate}
        duplicateFiles={duplicateFiles}
        comparisonCursor={comparisonCursor}
        setComparisonCursor={setComparisonCursor}
        staged={staged}
        stagedBytes={stagedBytes}
        stage={stage}
        unstage={unstage}
        trashStaged={trashStaged}
        onCollapse={onClearSelection}
      />
    );
  }

  return (
    <section className={panelClass}>
      <div className={panelHeaderClass}>
        <h2 className={panelTitleClass}>Duplicate Candidates</h2>
        <span className={panelMetaClass}><CopyCheck size={14} /> Size + partial + full hash</span>
      </div>
      <p className="-mt-1 mb-3 text-13 leading-normal text-muted">
        Duplicate groups start by identical file size, then matching candidates are refined with partial hashes and full-file hashes. A 100% confidence group means matching full hashes.
      </p>
      {duplicateCandidates.length === 0 ? (
        <div className={compactEmptyClass}>Files with identical sizes will appear here as duplicate candidates.</div>
      ) : (
        <ScrollableRows compact>
          {duplicateCandidates.map((candidate) => (
            <button
              className={duplicateRowClass(selectedDuplicateGroup === candidate.id)}
              key={candidate.id ?? candidate.size}
              type="button"
              onClick={() => void selectDuplicateCandidate(candidate)}
            >
              <div className="grid gap-1">
                <strong className="text-primary">{formatBytes(candidate.reclaimableBytes)} reclaimable</strong>
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted">{formatCount(candidate.files)} files at {formatBytes(candidate.size)} each</span>
              </div>
              <small className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted">{candidate.samples.join(" | ")}</small>
            </button>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}

function duplicateRowClass(active: boolean) {
  return [
    "grid min-h-[58px] w-full cursor-pointer grid-cols-[minmax(220px,0.45fr)_minmax(0,1fr)] items-center gap-4 border-0 border-t border-primary/10 bg-transparent p-0 text-left text-inherit max-sm:grid-cols-1 max-sm:py-2.5",
    active ? "bg-primary/10" : "hover:bg-primary/[0.055]",
  ].join(" ");
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-17 font-black uppercase text-primary";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-11 uppercase text-muted";
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-primary/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-muted";
