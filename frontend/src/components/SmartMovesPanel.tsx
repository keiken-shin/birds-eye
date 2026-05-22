import { computeSmartMoves } from "../utils/smartMoves";
import type { NativeDuplicateFile } from "../nativeClient";

interface SmartMovesPanelProps {
  files: NativeDuplicateFile[];
}

export function SmartMovesPanel({ files }: SmartMovesPanelProps) {
  const groups = computeSmartMoves(files);

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h3 className="font-mono text-11 font-black uppercase text-primary">Smart Moves</h3>
        <p className="text-11 text-muted">Consolidation suggestions based on folder overlap</p>
      </div>

      {groups.length === 0 ? (
        <p className="text-12 text-muted/50">No consolidation opportunities found.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <div
              key={group.targetFolder}
              className="flex flex-col gap-2 border border-primary/15 bg-white/[0.02] p-3"
            >
              <div>
                <p className="font-mono text-10 uppercase text-muted">Target folder</p>
                <p
                  className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11 text-primary"
                  title={group.targetFolder}
                >
                  {group.targetFolder}
                </p>
              </div>

              <div>
                <p className="font-mono text-10 uppercase text-muted">Files to move</p>
                <ul className="flex flex-col gap-0.5">
                  {group.filesToMove.map((filePath) => (
                    <li
                      key={filePath}
                      className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-11 text-primary/80"
                      title={filePath}
                    >
                      {lastSegment(filePath)}
                    </li>
                  ))}
                </ul>
              </div>

              <p className="text-11 text-muted">{group.reason}</p>
            </div>
          ))}
        </div>
      )}

      <p className="mt-auto border-t border-primary/10 pt-3 text-10 text-muted/60">
        Moves are not applied automatically — use your OS to act on these suggestions.
      </p>
    </div>
  );
}

function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
