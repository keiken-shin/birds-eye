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
    <section className="folder-table">
      <div className="panel-header">
        <h2>Duplicate Candidates</h2>
        <span><CopyCheck size={14} /> Size + partial + full hash</span>
      </div>
      <p className="section-note">
        Duplicate groups start by identical file size, then matching candidates are refined with partial hashes and full-file hashes. A 100% confidence group means matching full hashes.
      </p>
      {duplicateCandidates.length === 0 ? (
        <div className="empty-state compact">Files with identical sizes will appear here as duplicate candidates.</div>
      ) : (
        <>
          <ScrollableRows compact>
            {duplicateCandidates.map((candidate) => (
              <button
                className={`duplicate-row ${selectedDuplicateGroup === candidate.id ? "active" : ""}`}
                key={candidate.id ?? candidate.size}
                type="button"
                onClick={() => void selectDuplicateCandidate(candidate)}
              >
                <div>
                  <strong>{formatBytes(candidate.reclaimableBytes)} reclaimable</strong>
                  <span>{formatCount(candidate.files)} files at {formatBytes(candidate.size)} each</span>
                </div>
                <small>{candidate.samples.join(" | ")}</small>
              </button>
            ))}
          </ScrollableRows>
          {duplicateFiles.length > 0 && (
            <div className="duplicate-file-list">
              {duplicateFiles.map((file) => (
                <div className="folder-row file-row" key={file.path}>
                  <span>{file.path}</span>
                  <strong>{formatBytes(file.size)}</strong>
                  <small>{file.modified_at ? formatDate(file.modified_at) : "-"}</small>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
