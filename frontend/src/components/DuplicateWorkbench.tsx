import React, { useRef, useCallback } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { ComparisonPanel } from "./ComparisonPanel";
import type { ComparisonPanelProps } from "./ComparisonPanel";
import { AuditQueue } from "./AuditQueue";
import { VirtualRows } from "./VirtualRows";
import type { ScanState } from "../domain";
import type { TrashProgress } from "../hooks/useAuditQueue";
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
  trashProgress: TrashProgress;
  dismissProgress: () => void;
  nativeRuntime: boolean;
}

interface GroupsPanelProps {
  duplicateCandidates: DuplicateCandidate[];
  selectedDuplicateGroup: number | null;
  selectDuplicateCandidate: (c: DuplicateCandidate) => void;
}

function GroupsPanel({
  duplicateCandidates,
  selectedDuplicateGroup,
  selectDuplicateCandidate,
}: GroupsPanelProps) {
  const { collapse } = useCollapsedPanel("groups");
  return (
    <div className="flex h-full flex-col gap-1 border-r border-primary/15 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-13 font-black uppercase text-primary">Duplicate Groups</h3>
        <button
          type="button"
          onClick={collapse}
          aria-label="Collapse duplicate groups"
          title="Collapse duplicate groups"
          className="cursor-pointer grid h-7 w-7 shrink-0 place-items-center text-muted hover:border-white/30 hover:text-primary"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <VirtualRows
          items={duplicateCandidates}
          estimateRowHeight={70}
          maxHeight={999}
          className="h-full max-h-none"
          getKey={(candidate, idx) => candidate.id ?? `size-${candidate.size}-${idx}`}
          renderItem={(candidate, idx) => (
          <button
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
          )}
        />
      </div>
    </div>
  );
}

function ComparisonPanelWithExpanders(props: ComparisonPanelProps) {
  const { isCollapsed: groupsCollapsed, expand: expandGroups } = useCollapsedPanel("groups");
  const { isCollapsed: auditCollapsed, expand: expandAudit } = useCollapsedPanel("audit");

  return (
    <div className="relative flex h-full flex-1 flex-col">
      {(groupsCollapsed || auditCollapsed) && (
        <div className="flex items-center gap-2 border-b border-primary/10 px-3 py-2.5">
          {groupsCollapsed && (
            <button
              type="button"
              onClick={expandGroups}
              className="cursor-pointer font-mono flex items-center justify-center gap-1 uppercase text-muted hover:text-primary"
            >
              <PanelLeftOpen size={16} /> 
              <span className="font-sm font-black">Groups</span>
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
  trashProgress,
  dismissProgress,
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
    <section id="duplicates" className={workbenchClass} tabIndex={0} onKeyDown={handleKeyDown}>
      <ResizablePanelGroup id="workbench" className="flex-1">
        <ResizablePanel id="groups" defaultSize={200} minSize={140} collapsible>
          <GroupsPanel
            duplicateCandidates={duplicateCandidates}
            selectedDuplicateGroup={selectedDuplicateGroup}
            selectDuplicateCandidate={selectDuplicateCandidate}
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

        <ResizablePanelHandle rightPanelId="audit" />

        <ResizablePanel id="audit" defaultSize={220} minSize={160} collapsible>
          <AuditQueue
            staged={staged}
            stagedBytes={stagedBytes}
            stage={stage}
            unstage={unstage}
            trashStaged={trashStaged}
            trashProgress={trashProgress}
            dismissProgress={dismissProgress}
            duplicateFiles={duplicateFiles}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

function groupRowClass(active: boolean): string {
  const base = "cursor-pointer flex w-full flex-col items-start gap-0.5 border-b border-primary/10 px-2 py-2.5 text-left";
  return active ? `${base} bg-primary/10` : `${base} hover:bg-primary/[0.055]`;
}

const workbenchClass =
  "relative mt-5 flex h-[min(72vh,760px)] min-h-[480px] border border-white/15 bg-white/[0.045] shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
