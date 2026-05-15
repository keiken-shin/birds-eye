import { CopyCheck } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { formatDate } from "../utils/displayUtils";
import { ScrollableRows } from "./ScrollableRows";
import type { ScanState } from "../domain";
import type { NativeDuplicateFile } from "../nativeClient";

type DuplicateCandidate = ScanState["duplicateCandidates"][number];

interface DuplicatesSectionProps {
  duplicateCandidates: ScanState["duplicateCandidates"];
  selectedDuplicateGroup: number | null;
  selectDuplicateCandidate: (candidate: DuplicateCandidate) => void;
  duplicateFiles: NativeDuplicateFile[];
}

export function DuplicatesSection({
  duplicateCandidates,
  selectedDuplicateGroup,
  selectDuplicateCandidate,
  duplicateFiles,
}: DuplicatesSectionProps) {
  return (
    <section className={panelClass}>
      <div className={panelHeaderClass}>
        <h2 className={panelTitleClass}>Duplicate Candidates</h2>
        <span className={panelMetaClass}><CopyCheck size={14} /> Size + partial + full hash</span>
      </div>
      <p className="-mt-1 mb-3 text-[13px] leading-normal text-[#9a9a94]">
        Duplicate groups start by identical file size, then matching candidates are refined with partial hashes and full-file hashes. A 100% confidence group means matching full hashes.
      </p>
      {duplicateCandidates.length === 0 ? (
        <div className={compactEmptyClass}>Files with identical sizes will appear here as duplicate candidates.</div>
      ) : (
        <>
          <ScrollableRows compact>
            {duplicateCandidates.map((candidate) => (
              <button
                className={duplicateRowClass(selectedDuplicateGroup === candidate.id)}
                key={candidate.id ?? candidate.size}
                type="button"
                onClick={() => void selectDuplicateCandidate(candidate)}
              >
                <div className="grid gap-1">
                  <strong className="text-[#f4f1ea]">{formatBytes(candidate.reclaimableBytes)} reclaimable</strong>
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#9a9a94]">{formatCount(candidate.files)} files at {formatBytes(candidate.size)} each</span>
                </div>
                <small className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#9a9a94]">{candidate.samples.join(" | ")}</small>
              </button>
            ))}
          </ScrollableRows>
          {duplicateFiles.length > 0 && (
            <div className="mt-3 grid border-t border-[#f4f1ea]/15">
              {duplicateFiles.map((file) => (
                <div className={fileRowClass} key={file.path}>
                  <span className={pathClass}>{file.path}</span>
                  <strong className={valueClass}>{formatBytes(file.size)}</strong>
                  <small className={smallClass}>{file.modified_at ? formatDate(file.modified_at) : "-"}</small>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function duplicateRowClass(active: boolean) {
  return [
    "grid min-h-[58px] w-full cursor-pointer grid-cols-[minmax(220px,0.45fr)_minmax(0,1fr)] items-center gap-4 border-0 border-t border-[#f4f1ea]/10 bg-transparent p-0 text-left text-inherit max-sm:grid-cols-1 max-sm:py-2.5",
    active ? "bg-[#f4f1ea]/10" : "hover:bg-[#f4f1ea]/[0.055]",
  ].join(" ");
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)] before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-[18px] before:w-[18px] before:border-l-2 before:border-t-2 before:border-[#f4f1ea]/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-[17px] font-black uppercase text-[#f4f1ea]";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-[#9a9a94]";
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-[#f4f1ea]/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-[#9a9a94]";
const fileRowClass = "grid min-h-12 grid-cols-[minmax(0,1fr)_110px_72px] items-center gap-3 border-t border-[#f4f1ea]/10 max-sm:grid-cols-1 max-sm:gap-1 max-sm:py-2.5";
const pathClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#dedbd4]";
const valueClass = "text-right text-[#f4f1ea] max-sm:text-left";
const smallClass = "text-right font-mono text-[#9a9a94] max-sm:text-left";
