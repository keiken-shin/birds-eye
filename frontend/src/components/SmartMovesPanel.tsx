import { formatBytes } from "../domain";
import { truncatePath } from "../utils/pathUtils";
import { computeSmartMoves, groupByParentFolder } from "../utils/smartMoves";
import type { NativeDuplicateFile } from "../nativeClient";

interface SmartMovesPanelProps {
  duplicateFiles: NativeDuplicateFile[];
  stage: (file: NativeDuplicateFile) => void;
}

export function SmartMovesPanel({ duplicateFiles, stage }: SmartMovesPanelProps) {
  const folderMoves = groupByParentFolder(duplicateFiles);
  const fileMoves = computeSmartMoves(duplicateFiles);

  if (folderMoves.length === 0 && fileMoves.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4 text-center">
        <p className="text-12 text-muted/50">No move suggestions for this group.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {folderMoves.length > 0 ? (
        <>
          <h3 className="text-13 font-black uppercase text-primary">Folder Moves</h3>
          {folderMoves.map((move, idx) => (
            <div key={`${move.keepFolder}-${move.stageFolder}-${idx}`} className="border border-white/10 bg-white/[0.02] p-3">
              <div className="grid gap-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-10 uppercase text-muted">Keep</span>
                  <span
                    className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11 text-primary"
                    title={move.keepFolder}
                  >
                    {truncatePath(move.keepFolder)}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-10 uppercase text-muted">Stage</span>
                  <span
                    className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11 text-muted"
                    title={move.stageFolder}
                  >
                    {truncatePath(move.stageFolder)}
                  </span>
                </div>
              </div>
              <p className="mt-1.5 font-mono text-10 text-muted">
                {move.fileCount} files / {formatBytes(move.reclaimableBytes)} reclaimable
              </p>
              <button
                type="button"
                onClick={() => move.files.forEach(stage)}
                className="mt-2 w-full border border-primary/30 py-1.5 font-mono text-10 uppercase text-primary hover:bg-primary/10"
              >
                Apply - Stage {move.fileCount} files
              </button>
            </div>
          ))}
        </>
      ) : (
        <>
          <p className="font-mono text-10 text-muted/50">
            No folder-level patterns detected - showing file suggestions.
          </p>
          {fileMoves.map((move, idx) => (
            <div key={`${move.targetFolder}-${idx}`} className="border border-white/10 bg-white/[0.02] p-3">
              <p className="font-mono text-11 text-primary" title={move.targetFolder}>
                {truncatePath(move.targetFolder)}
              </p>
              <p className="mt-1 text-12 text-muted">{move.reason}</p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
