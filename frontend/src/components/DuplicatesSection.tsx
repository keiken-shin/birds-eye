import { DuplicateWorkbench } from "./DuplicateWorkbench";
import type { ScanState } from "../domain";
import type { TrashProgress } from "../hooks/useAuditQueue";
import type { NativeDuplicateFile } from "../nativeClient";

type DuplicateCandidate = ScanState["duplicateCandidates"][number];

interface DuplicatesSectionProps {
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
  trashProgress: TrashProgress;
  dismissProgress: () => void;
  nativeRuntime: boolean;
}

export function DuplicatesSection({
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
  trashProgress,
  dismissProgress,
  nativeRuntime,
}: DuplicatesSectionProps) {
  if (duplicateCandidates.length > 0) {
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
        trashProgress={trashProgress}
        dismissProgress={dismissProgress}
        nativeRuntime={nativeRuntime}
      />
    );
  }

  return (
    <section id="duplicates" className={panelClass}>
      <div className={panelHeaderClass}>
        <h2 className={panelTitleClass}>Duplicate Candidates</h2>
        <span className={panelMetaClass}>Size + partial + full hash</span>
      </div>
      <p className="-mt-1 mb-3 text-13 leading-normal text-muted">
        Duplicate groups start by identical file size, then matching candidates are refined with partial hashes and full-file hashes. A 100% confidence group means matching full hashes.
      </p>
      <div className={compactEmptyClass}>Files with identical sizes will appear here as duplicate candidates.</div>
    </section>
  );
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-17 font-black uppercase text-primary";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-11 uppercase text-muted";
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-primary/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-muted";
