import { useState, useCallback } from "react";
import type React from "react";
import { ChevronLeft, ChevronRight, FolderOpen } from "lucide-react";
import { formatBytes } from "../domain";
import { formatDate } from "../utils/displayUtils";
import type { NativeDuplicateFile } from "../nativeClient";
import { revealInExplorer } from "../nativeClient";
import { suggestKeep } from "../utils/smartMoves";
import { MediaPreview } from "./MediaPreview";
import { truncatePath } from "../utils/pathUtils";

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

export function ComparisonPanel({ files, cursor, setCursor, staged, stage, unstage, nativeRuntime, videoRefs }: ComparisonPanelProps) {
  const left = files[cursor];
  const right = files[cursor + 1];

  const videoRef0 = useCallback(
    (el: HTMLVideoElement | null) => {
      if (videoRefs) {
        if (el) videoRefs.current[0] = el;
        else delete videoRefs.current[0];
      }
    },
    [videoRefs]
  );

  const videoRef1 = useCallback(
    (el: HTMLVideoElement | null) => {
      if (videoRefs) {
        if (el) videoRefs.current[1] = el;
        else delete videoRefs.current[1];
      }
    },
    [videoRefs]
  );

  const diffFields = new Set<string>();
  if (left && right) {
    if (left.size !== right.size) diffFields.add("size");
    if (left.modified_at !== right.modified_at) diffFields.add("modified");
    const leftFolder = left.path.replace(/[\\/][^\\/]+$/, "");
    const rightFolder = right.path.replace(/[\\/][^\\/]+$/, "");
    if (leftFolder !== rightFolder) diffFields.add("folder");
  }

  if (!left || !right) {
    return (
      <div className="grid flex-1 place-items-center text-muted text-13">
        Select a group with 2+ copies to compare.
      </div>
    );
  }

  const suggestedPath = suggestKeep(files);
  const confidence = confidenceLabel(Math.max(left.hash_state, right.hash_state));

  function handleKeepLeft() {
    unstage(left.path);
    stage(right);
  }

  function handleKeepRight() {
    unstage(right.path);
    stage(left);
  }

  return (
    <div className="flex flex-1 flex-col gap-3 p-5 min-w-0">
      <div className="flex items-baseline justify-between gap-4 uppercase">
        <h3 className="text-13 font-black uppercase text-primary">Copy Comparison</h3>
        <span className={confidenceBadgeClass(Math.max(left.hash_state, right.hash_state))}>{confidence}</span>
      </div>

      {suggestedPath && (
        <div className="border border-primary/20 bg-primary/[0.04] px-3 py-2 text-12 text-primary">
          ★ Suggested keep: <strong>{lastSegment(suggestedPath)}</strong> — most likely active copy
        </div>
      )}

      <div className="grid flex-1 grid-cols-2 gap-3">
        <CopyCard
          file={left}
          label="A"
          isKept={!staged.has(left.path)}
          isSuggested={left.path === suggestedPath}
          diffFields={diffFields}
          onKeep={handleKeepLeft}
          onStage={() => stage(left)}
          nativeRuntime={nativeRuntime}
          videoRef={videoRefs ? videoRef0 : undefined}
        />
        <CopyCard
          file={right}
          label="B"
          isKept={!staged.has(right.path)}
          isSuggested={right.path === suggestedPath}
          diffFields={diffFields}
          onKeep={handleKeepRight}
          onStage={() => stage(right)}
          nativeRuntime={nativeRuntime}
          videoRef={videoRefs ? videoRef1 : undefined}
        />
      </div>

      {files.length > 2 && (
        <div className="flex items-center justify-between border-t border-primary/10 pt-3 font-mono text-11 text-muted">
          <span>{files.length} copies · viewing {cursor + 1}–{Math.min(cursor + 2, files.length)} of {files.length}</span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={cursor === 0}
              onClick={() => setCursor(cursor - 1)}
              className="grid h-6 w-6 place-items-center border border-white/15 disabled:opacity-30"
            >
              <ChevronLeft size={12} />
            </button>
            <button
              type="button"
              disabled={cursor >= files.length - 2}
              onClick={() => setCursor(cursor + 1)}
              className="grid h-6 w-6 place-items-center border border-white/15 disabled:opacity-30"
            >
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface CopyCardProps {
  file: NativeDuplicateFile;
  label: "A" | "B";
  isKept: boolean;
  isSuggested: boolean;
  diffFields: Set<string>;
  onKeep: () => void;
  onStage: () => void;
  nativeRuntime: boolean;
  videoRef?: (el: HTMLVideoElement | null) => void;
}

function CopyCard({ file, label, isKept, isSuggested, diffFields, onKeep, onStage, nativeRuntime, videoRef }: CopyCardProps) {
  const folder = file.path.replace(/[\\/][^\\/]+$/, "");

  return (
    <div className={cardClass(isKept, isSuggested)}>
      <div className={cardHeaderClass(isKept)}>
        <span className="font-mono text-11 font-black uppercase">
          Copy {label}{isSuggested ? " ★" : ""}
        </span>
        <span className={cardBadgeClass(isKept)}>{isKept ? "keeping" : "staged"}</span>
      </div>

      {/* Media preview region */}
      <div
        ref={(wrapper) => {
          if (videoRef) {
            videoRef(wrapper ? wrapper.querySelector("video") : null);
          }
        }}
      >
        <MediaPreview path={file.path} />
      </div>

      <div className="flex flex-col gap-3 p-3">
        <Field label="path" value={truncatePath(file.path)} fullValue={file.path} mono />
        <div className="grid grid-cols-2 gap-3">
          <Field label="size" value={formatBytes(file.size)} isDiff={diffFields.has("size")} />
          <Field
            label="modified"
            value={file.modified_at ? formatDate(file.modified_at) : "—"}
            isDiff={diffFields.has("modified")}
          />
        </div>
        <Field
          label="folder"
          value={truncatePath(folder)}
          fullValue={folder}
          mono
          isDiff={diffFields.has("folder")}
        />
        <ConfidenceField hashState={file.hash_state} />
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={isKept ? onStage : onKeep}
            className={cardToggleClass(isKept)}
          >
            {isKept ? "Stage for trash" : "Keep this instead"}
          </button>
          {nativeRuntime && (
            <RevealButton path={file.path} />
          )}
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, fullValue, mono, isDiff,
}: {
  label: string;
  value: string;
  fullValue?: string;
  mono?: boolean;
  isDiff?: boolean;
}) {
  return (
    <div className={`grid gap-0.5 ${isDiff ? "border-l-2 border-amber-400/60 pl-2" : ""}`}>
      <span className="font-mono text-10 uppercase text-muted">{label}</span>
      <span
        title={fullValue}
        className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-13 ${mono ? "font-mono" : ""} ${isDiff ? "text-amber-300" : "text-primary"}`}
      >
        {value}
      </span>
    </div>
  );
}

function ConfidenceField({ hashState }: { hashState: number }) {
  const [showTip, setShowTip] = useState(false);
  return (
    <div className="grid gap-0.5">
      <span className="font-mono text-10 uppercase text-muted">hash confidence</span>
      <div className="relative flex items-center gap-1">
        <span className="text-13 text-primary">{confidenceLabel(hashState)}</span>
        <span
          className="cursor-help select-none font-mono text-10 text-muted/50 hover:text-muted"
          onMouseEnter={() => setShowTip(true)}
          onMouseLeave={() => setShowTip(false)}
        >
          ⓘ
        </span>
        {showTip && (
          <div className="pointer-events-none absolute bottom-full left-0 z-50 mb-1.5 w-60 border border-white/15 bg-[#0d0d0d] p-2 font-mono text-10 leading-relaxed text-muted shadow-overlay">
            {confidenceTip(hashState)}
          </div>
        )}
      </div>
    </div>
  );
}

function RevealButton({ path }: { path: string }) {
  const [showTip, setShowTip] = useState(false);
  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label="Reveal in Explorer"
        onClick={() => void revealInExplorer(path).catch(() => {})}
        onMouseEnter={() => setShowTip(true)}
        onMouseLeave={() => setShowTip(false)}
        className="grid h-7 w-7 place-items-center border border-white/15 text-muted hover:border-white/30 hover:text-primary"
      >
        <FolderOpen size={12} />
      </button>
      {showTip && (
        <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-1 whitespace-nowrap border border-white/15 bg-[#0d0d0d] px-1.5 py-0.5 font-mono text-10 text-muted">
          Reveal in Explorer
        </div>
      )}
    </div>
  );
}

function confidenceLabel(hashState: number): string {
  if (hashState >= 4) return "Full-file XXH3 ✓";
  if (hashState >= 2) return "Sample hash";
  return "Size match only";
}

function confidenceTip(hashState: number): string {
  if (hashState >= 4)
    return "The entire file was hashed end-to-end. Content is confirmed identical.";
  if (hashState >= 2)
    return "A chunk of each file was hashed and matched. Very likely identical, but not fully verified.";
  return "Files match by size alone. There's a small chance they differ in content — verify before deleting.";
}

function confidenceBadgeClass(hashState: number): string {
  const base = "inline-flex items-center gap-1.5 font-mono text-11 uppercase";
  if (hashState >= 4) return `${base} text-primary`;
  if (hashState >= 2) return `${base} text-muted`;
  return `${base} text-muted/60`;
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function cardClass(isKept: boolean, isSuggested: boolean): string {
  const base = "flex flex-col overflow-hidden border";
  if (isSuggested && isKept) return `${base} border-primary/40 bg-primary/[0.04]`;
  if (!isKept) return `${base} border-white/10 opacity-60`;
  return `${base} border-white/15`;
}

function cardHeaderClass(isKept: boolean): string {
  const base = "flex items-center justify-between px-3 py-2";
  return isKept ? `${base} bg-primary/10` : `${base} bg-white/5`;
}

function cardBadgeClass(isKept: boolean): string {
  const base = "font-mono text-10 uppercase px-1.5 py-0.5 border";
  return isKept
    ? `${base} border-primary/30 text-primary`
    : `${base} border-white/15 text-muted`;
}

function cardToggleClass(isKept: boolean): string {
  const base = "flex-1 border py-1.5 font-mono text-10 uppercase transition-colors";
  return isKept
    ? `${base} border-white/15 text-muted hover:border-white/30 hover:text-primary`
    : `${base} border-primary/30 text-primary hover:bg-primary/10`;
}
