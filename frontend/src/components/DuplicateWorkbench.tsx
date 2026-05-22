import React, { useRef, useCallback } from "react";
import { formatBytes, formatCount } from "../domain";
import { ComparisonPanel } from "./ComparisonPanel";
import { AuditQueue } from "./AuditQueue";
import type { ScanState } from "../domain";
import type { NativeDuplicateFile } from "../nativeClient";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizablePanelHandle,
  useCollapsedPanel,
} from "./ResizablePanel";

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

interface GroupsPanelProps {
  duplicateCandidates: DuplicateCandidate[];
  selectedDuplicateGroup: number | null;
  selectDuplicateCandidate: (c: DuplicateCandidate) => void;
  onCollapse: () => void;
}

function GroupsPanel({
  duplicateCandidates,
  selectedDuplicateGroup,
  selectDuplicateCandidate,
  onCollapse,
}: GroupsPanelProps) {
  return (
    <div className="flex h-full flex-col gap-1 border-r border-primary/15 p-4">
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
            <span className="text-muted text-11">
              {formatCount(candidate.files)} files · {formatBytes(candidate.size)} each
            </span>
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
  );
}

interface ComparisonPanelProps {
  files: NativeDuplicateFile[];
  cursor: number;
  setCursor: (n: number) => void;
  staged: Map<string, NativeDuplicateFile>;
  stage: (file: NativeDuplicateFile) => void;
  unstage: (path: string) => void;
  nativeRuntime: boolean;
  videoRefs?: React.MutableRefObject<HTMLVideoElement[]>;
}

function ComparisonPanelWithExpanders(props: ComparisonPanelProps) {
  const { isCollapsed: groupsCollapsed, expand: expandGroups } = useCollapsedPanel("groups");
  const { isCollapsed: auditCollapsed, expand: expandAudit } = useCollapsedPanel("audit");

  return (
    <div className="relative flex h-full flex-1 flex-col">
      {(groupsCollapsed || auditCollapsed) && (
        <div className="flex items-center gap-2 border-b border-primary/10 px-3 py-1.5">
          {groupsCollapsed && (
            <button
              type="button"
              onClick={expandGroups}
              className="font-mono text-10 uppercase text-muted hover:text-primary"
            >
              ‹ Groups
            </button>
          )}
          {auditCollapsed && (
            <button
              type="button"
              onClick={expandAudit}
              className="ml-auto font-mono text-10 uppercase text-muted hover:text-primary"
            >
              Audit ›
            </button>
          )}
        </div>
      )}
      <ComparisonPanel {...props} />
    </div>
  );
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
  const videoRefs = useRef<HTMLVideoElement[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "a" || e.key === "ArrowLeft") {
        e.preventDefault();
        const left = duplicateFiles[comparisonCursor];
        const right = duplicateFiles[comparisonCursor + 1];
        if (left && right) { unstage(left.path); stage(right); }
      } else if (e.key === "d" || e.key === "ArrowRight") {
        e.preventDefault();
        const left = duplicateFiles[comparisonCursor];
        const right = duplicateFiles[comparisonCursor + 1];
        if (left && right) { unstage(right.path); stage(left); }
      } else if (e.key === " ") {
        e.preventDefault();
        const [v0, v1] = videoRefs.current;
        if (v0 && v1) {
          if (v0.paused) { void v0.play(); void v1.play(); }
          else { v0.pause(); v1.pause(); }
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (comparisonCursor < duplicateFiles.length - 2) {
          setComparisonCursor(comparisonCursor + 1);
        }
      }
    },
    [duplicateFiles, comparisonCursor, setComparisonCursor, stage, unstage]
  );

  return (
    <section className={workbenchClass} tabIndex={0} onKeyDown={handleKeyDown}>
      <ResizablePanelGroup id="workbench" className="flex-1">
        <ResizablePanel id="groups" defaultSize={200} minSize={140} collapsible>
          <GroupsPanel
            duplicateCandidates={duplicateCandidates}
            selectedDuplicateGroup={selectedDuplicateGroup}
            selectDuplicateCandidate={selectDuplicateCandidate}
            onCollapse={onCollapse}
          />
        </ResizablePanel>

        <ResizablePanelHandle leftPanelId="groups" />

        <ResizablePanel id="comparison" flex>
          <ComparisonPanelWithExpanders
            files={duplicateFiles}
            cursor={comparisonCursor}
            setCursor={setComparisonCursor}
            staged={staged}
            stage={stage}
            unstage={unstage}
            nativeRuntime={nativeRuntime}
            videoRefs={videoRefs}
          />
        </ResizablePanel>

        <ResizablePanelHandle leftPanelId="comparison" />

        <ResizablePanel id="audit" defaultSize={220} minSize={160} collapsible>
          <AuditQueue
            staged={staged}
            stagedBytes={stagedBytes}
            unstage={unstage}
            trashStaged={trashStaged}
            duplicateFiles={duplicateFiles}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function groupRowClass(active: boolean): string {
  const base = "flex w-full flex-col items-start gap-0.5 border-b border-primary/10 px-2 py-2.5 text-left";
  return active ? `${base} bg-primary/10` : `${base} hover:bg-primary/[0.055]`;
}

const workbenchClass =
  "relative mt-5 flex min-h-[480px] border border-white/15 bg-white/[0.045] shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
