import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatBytes } from "../domain";
import { formatDate } from "../utils/displayUtils";
import type { NativeDuplicateFile } from "../nativeClient";

interface ComparisonPanelProps {
  files: NativeDuplicateFile[];
  cursor: number;
  setCursor: (n: number) => void;
  staged: Map<string, NativeDuplicateFile>;
  stage: (file: NativeDuplicateFile) => void;
  unstage: (path: string) => void;
}

export function ComparisonPanel({ files, cursor, setCursor, staged, stage, unstage }: ComparisonPanelProps) {
  const left = files[cursor];
  const right = files[cursor + 1];

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
          onKeep={handleKeepLeft}
          onStage={() => stage(left)}
        />
        <CopyCard
          file={right}
          label="B"
          isKept={!staged.has(right.path)}
          isSuggested={right.path === suggestedPath}
          onKeep={handleKeepRight}
          onStage={() => stage(right)}
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
  onKeep: () => void;
  onStage: () => void;
}

function CopyCard({ file, label, isKept, isSuggested, onKeep, onStage }: CopyCardProps) {
  const folder = file.path.replace(/[\\/][^\\/]+$/, "");

  return (
    <div className={cardClass(isKept, isSuggested)}>
      <div className={cardHeaderClass(isKept)}>
        <span className="font-mono text-11 font-black uppercase">
          Copy {label}{isSuggested ? " ★" : ""}
        </span>
        <span className={cardBadgeClass(isKept)}>{isKept ? "keeping" : "staged"}</span>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <Field label="path" value={file.path} mono />
        <div className="grid grid-cols-2 gap-3">
          <Field label="size" value={formatBytes(file.size)} />
          <Field label="modified" value={file.modified_at ? formatDate(file.modified_at) : "—"} />
        </div>
        <Field label="folder" value={folder} mono />
        <Field label="hash confidence" value={confidenceLabel(file.hash_state)} />
        <button
          type="button"
          onClick={isKept ? onStage : onKeep}
          className={cardToggleClass(isKept)}
        >
          {isKept ? "Stage for trash" : "Keep this instead"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <span className="font-mono text-10 uppercase text-muted">{label}</span>
      <span className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-13 text-primary ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

export function suggestKeep(files: NativeDuplicateFile[]): string {
  if (files.length === 0) return "";
  const SUSPECT = /\b(backup|old|archive|copy|temp|202\d)\b/i;
  return [...files].sort((a, b) => {
    const aSuspect = SUSPECT.test(a.path) ? 1 : 0;
    const bSuspect = SUSPECT.test(b.path) ? 1 : 0;
    if (aSuspect !== bSuspect) return aSuspect - bSuspect;
    const aTime = a.modified_at ?? 0;
    const bTime = b.modified_at ?? 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length;
  })[0].path;
}

function confidenceLabel(hashState: number): string {
  if (hashState >= 4) return "Full-file XXH3 ✓";
  if (hashState >= 2) return "Sample hash";
  return "Size match only";
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
  const base = "mt-1 w-full border py-1.5 font-mono text-10 uppercase transition-colors";
  return isKept
    ? `${base} border-white/15 text-muted hover:border-white/30 hover:text-primary`
    : `${base} border-primary/30 text-primary hover:bg-primary/10`;
}
