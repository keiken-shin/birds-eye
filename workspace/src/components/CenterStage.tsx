import { formatBytes } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { nodeName, scopeChildren, scopeTotalBytes } from "../lib/folderTree";
import { TreemapLens } from "./TreemapLens";
import { BoardLens } from "./BoardLens";
import { ResultsLens } from "./ResultsLens";

export function CenterStage() {
  const { tree, activeEntry, reclaimableTotal } = useIndexData();
  const { lens, scopePath, popScopeTo } = useWorkspace();

  const rootName = activeEntry?.root_path ? nodeName(activeEntry.root_path) : "Storage";
  const crumbs = [rootName, ...scopePath.map(nodeName)];
  const children = tree ? scopeChildren(tree, scopePath) : [];
  const scopeTotal = scopeTotalBytes(children);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-window">
      <div className="flex h-10 flex-none items-center gap-1.5 border-b border-line-soft px-3.5 text-12">
        {crumbs.map((name, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={i} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => popScopeTo(i)}
                style={{ color: last ? "var(--color-ink)" : "var(--color-faint)", fontWeight: last ? 600 : 400 }}
              >
                {name}
              </button>
              {!last && <span className="text-[#3a3f48]">/</span>}
            </span>
          );
        })}
        <span className="ml-auto flex items-center gap-3 text-11 text-dim">
          <span className="mono">{formatBytes(scopeTotal)}</span>
          <span className="text-[#3a3f48]">·</span>
          <span className="text-primary-ink">{formatBytes(reclaimableTotal)} reclaimable</span>
        </span>
      </div>

      {lens === "treemap" && <TreemapLens />}
      {lens === "board" && <BoardLens />}
      {lens === "results" && <ResultsLens />}
    </div>
  );
}
