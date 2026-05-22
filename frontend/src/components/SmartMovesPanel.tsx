import { useMemo } from "react";
import { computeSmartMoves } from "../utils/smartMoves";
import type { NativeDuplicateFile } from "../nativeClient";

interface SmartMovesPanelProps {
  duplicateFiles: NativeDuplicateFile[];
}

export function SmartMovesPanel({ duplicateFiles }: SmartMovesPanelProps) {
  const groups = useMemo(() => computeSmartMoves(duplicateFiles), [duplicateFiles]);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
      <div>
        <h3 className="font-mono text-11 font-black uppercase text-muted">Smart Moves</h3>
        <p className="text-10 text-muted/60">Consolidation suggestions based on folder overlap</p>
      </div>

      {groups.length === 0 ? (
        <p className="text-12 text-muted/50">No consolidation opportunities found.</p>
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
          {groups.map((group) => (
            <MoveCard
              key={group.targetFolder}
              targetFolder={group.targetFolder}
              filesToMove={group.filesToMove}
              reason={group.reason}
            />
          ))}
        </div>
      )}

      <p className="mt-auto border-t border-primary/10 pt-3 font-mono text-10 text-muted/60">
        Moves are not applied automatically — use your OS to act on these suggestions.
      </p>
    </div>
  );
}

function MoveCard({
  targetFolder,
  filesToMove,
  reason,
}: {
  targetFolder: string;
  filesToMove: string[];
  reason: string;
}) {
  return (
    <div className="border border-white/10 bg-white/[0.02] p-3">
      <p className="font-mono text-10 font-black uppercase text-primary">Consolidate here</p>
      <p
        className="mt-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11 text-primary"
        title={targetFolder}
      >
        {targetFolder}
      </p>
      <p className="mt-1 text-10 text-muted">{reason}</p>
      <div className="mt-2 flex flex-col gap-0.5 border-t border-white/10 pt-2">
        <p className="font-mono text-10 uppercase text-muted/60">Move these files here:</p>
        {filesToMove.map((path) => (
          <p
            key={path}
            className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-10 text-muted"
            title={path}
          >
            {lastSegment(path)}
          </p>
        ))}
      </div>
    </div>
  );
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
