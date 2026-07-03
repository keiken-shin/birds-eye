import { formatBytes } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { nodeName, type FolderNode } from "../lib/folderTree";
import { VERDICT_STYLES, verdictForFolder } from "../lib/verdict";

export function ScopeTree() {
  const { tree, lensByPath, indexes, activeEntry } = useIndexData();
  const { scopePath, selected, ontologyEnabled, setOverlay, select, setIndexPath, setScopePath } =
    useWorkspace();

  const dotColor = (node: FolderNode): string => {
    const row = lensByPath.get(node.path);
    if (!ontologyEnabled || !row) return "#6b7178";
    return VERDICT_STYLES[verdictForFolder(row)].tx;
  };

  // Clicking a row replaces the scope with that node's own chain (never accumulates), and
  // re-clicking the active node collapses it. `parent` is the top-level path for depth-1 rows.
  const onRow = (node: FolderNode, parent: string | null) => {
    const isScoped = scopePath[scopePath.length - 1] === node.path;
    if (isScoped || selected?.path === node.path) {
      select(null);
      if (isScoped) setScopePath(parent ? [parent] : []);
      return;
    }
    select({ kind: "folder", path: node.path, name: node.name, bytes: node.bytes });
    const chain = parent ? [parent, node.path] : [node.path];
    setScopePath(node.hasChildren ? chain : parent ? [parent] : []);
  };

  const rows: Array<{ node: FolderNode; depth: number; parent: string | null }> = [];
  for (const top of tree?.topLevel ?? []) {
    rows.push({ node: top, depth: 0, parent: null });
    if (scopePath.includes(top.path)) {
      for (const childPath of top.childrenPaths) {
        const child = tree!.byPath.get(childPath);
        if (child) rows.push({ node: child, depth: 1, parent: top.path });
      }
    }
  }

  return (
    <div className="flex w-[230px] flex-none flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-3 pb-2.5 pt-3.5">
        <span className="text-10 tracking-[0.14em] text-label">SCOPE</span>
        <button
          type="button"
          onClick={() => setOverlay("scan")}
          className="rounded-[6px] border border-primary/30 px-2 py-0.5 text-[10.5px] text-primary"
        >
          + scan
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {rows.map(({ node, depth, parent }) => {
          const active = scopePath.includes(node.path) || selected?.path === node.path;
          const expanded = scopePath.includes(node.path);
          return (
            <button
              key={node.path}
              type="button"
              onClick={() => onRow(node, parent)}
              className="flex w-full items-center justify-between rounded-[7px] px-2 py-1.5 text-left text-[12.5px]"
              style={{
                paddingLeft: depth ? 22 : 8,
                color: active ? "var(--color-ink)" : "#aab0b8",
                background: active ? "rgba(61,220,132,.1)" : "transparent",
                border: active ? "1px solid rgba(61,220,132,.3)" : "1px solid transparent",
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="text-[9px]" style={{ color: depth ? dotColor(node) : "#6b7178" }}>
                  {depth ? "•" : expanded ? "▾" : "▸"}
                </span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{node.name}</span>
              </span>
              <span className="mono flex-none text-[10.5px] text-dim">{formatBytes(node.bytes)}</span>
            </button>
          );
        })}
        {!rows.length && (
          <div className="px-2 py-3 text-11 italic text-label">No folders in scope.</div>
        )}

        <div className="mx-1 mb-2 mt-3.5 text-10 tracking-[0.14em] text-label">◷ RECENT SCANS</div>
        {indexes.map((e) => (
          <button
            key={e.index_path}
            type="button"
            onClick={() => {
              setIndexPath(e.index_path);
              setScopePath([]);
            }}
            className="flex w-full items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-left text-[11.5px]"
            style={{ color: e.index_path === activeEntry?.index_path ? "var(--color-primary-ink)" : "#9aa0a8" }}
          >
            <span className="text-history">▸</span>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {e.root_path ? nodeName(e.root_path) : "index"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
