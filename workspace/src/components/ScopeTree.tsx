import { ChevronDown, ChevronRight, HardDrive, PanelLeftClose, ScanLine } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { nodeName, type FolderNode } from "../lib/folderTree";
import { verdictForFolder } from "../lib/verdict";
import { Button, IconButton } from "./ui/Button";
import { SectionLabel } from "./ui/Card";
import { useSidePanel } from "./ui/SidePanel";

function scannedAgo(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : `${Math.floor(d / 30)}mo ago`;
}

export function ScopeTree() {
  const { tree, lensByPath, indexes, activeEntry, status } = useIndexData();
  const { scopePath, selected, ontologyEnabled, setOverlay, select, setIndexPath, setScopePath } =
    useWorkspace();
  const panel = useSidePanel();

  const dotColor = (node: FolderNode): string => {
    const row = lensByPath.get(node.path);
    if (!ontologyEnabled || !row) return "var(--color-dim)";
    return `var(--color-${verdictForFolder(row)}-tx)`;
  };

  /** Scope chain from the root down to `node` — its ancestors are always a prefix of
   *  scopePath (rows only render while every ancestor is expanded). */
  const chainTo = (node: FolderNode, parent: string | null): string[] => {
    if (!parent) return [node.path];
    return [...scopePath.slice(0, scopePath.indexOf(parent) + 1), node.path];
  };
  const chainToParent = (parent: string | null): string[] =>
    parent ? scopePath.slice(0, scopePath.indexOf(parent) + 1) : [];

  /** Caret: expansion only — selection is untouched. */
  const onCaret = (node: FolderNode, parent: string | null) => {
    const idx = scopePath.indexOf(node.path);
    if (idx >= 0) setScopePath(scopePath.slice(0, idx));
    else setScopePath(chainTo(node, parent));
  };

  // Clicking a name replaces the scope with that node's own chain (never accumulates),
  // and re-clicking the active node collapses back to its parent chain.
  const onName = (node: FolderNode, parent: string | null) => {
    const isScoped = scopePath[scopePath.length - 1] === node.path;
    if (isScoped || selected?.path === node.path) {
      select(null);
      if (isScoped) setScopePath(chainToParent(parent));
      return;
    }
    select({ kind: "folder", path: node.path, name: node.name, bytes: node.bytes });
    setScopePath(node.hasChildren ? chainTo(node, parent) : chainToParent(parent));
  };

  // Rows for every expanded level: walk children along the whole scopePath chain.
  const rows: Array<{ node: FolderNode; depth: number; parent: string | null }> = [];
  const pushChildren = (node: FolderNode, depth: number) => {
    for (const childPath of node.childrenPaths) {
      const child = tree?.byPath.get(childPath);
      if (!child) continue;
      rows.push({ node: child, depth, parent: node.path });
      if (child.hasChildren && scopePath.includes(child.path)) pushChildren(child, depth + 1);
    }
  };
  for (const top of tree?.topLevel ?? []) {
    rows.push({ node: top, depth: 0, parent: null });
    if (top.hasChildren && scopePath.includes(top.path)) pushChildren(top, 1);
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center gap-1 px-3 pb-2.5 pt-3.5">
        <SectionLabel className="min-w-0 flex-1">Scope</SectionLabel>
        <Button variant="subtle" size="sm" icon={ScanLine} onClick={() => setOverlay("scan")}>
          Scan
        </Button>
        {panel ? (
          <IconButton icon={PanelLeftClose} label="Hide panel" size={13} onClick={panel.collapse} />
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {rows.map(({ node, depth, parent }) => {
          // Only the node itself gets the full pill; ancestors on the scope
          // chain read as quietly "on the path" without competing with it.
          const active =
            selected?.path === node.path || scopePath[scopePath.length - 1] === node.path;
          const expanded = scopePath.includes(node.path);
          const onPath = expanded && !active;
          const Caret = expanded ? ChevronDown : ChevronRight;
          return (
            <div
              key={node.path}
              className={`flex w-full items-center gap-1 rounded-[7px] border py-1 pr-2 text-125 transition-colors ${
                active
                  ? "border-primary-edge bg-primary-dim text-ink"
                  : onPath
                    ? "border-transparent text-ink-soft hover:text-ink"
                    : "border-transparent text-muted hover:text-ink"
              }`}
              style={{ paddingLeft: 4 + depth * 14 }}
            >
              {node.hasChildren ? (
                <button
                  type="button"
                  aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                  aria-expanded={expanded}
                  onClick={() => onCaret(node, parent)}
                  className="flex h-4 w-4 flex-none items-center justify-center rounded text-faint transition-colors hover:text-ink"
                >
                  <Caret size={12} strokeWidth={2} aria-hidden />
                </button>
              ) : (
                <span className="h-4 w-4 flex-none" aria-hidden />
              )}
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: dotColor(node) }}
                aria-hidden
              />
              <button
                type="button"
                onClick={() => onName(node, parent)}
                className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap py-0.5 text-left"
              >
                {node.name}
              </button>
              <span className="mono flex-none text-right text-105 text-dim">
                {formatBytes(node.bytes)}
              </span>
            </div>
          );
        })}
        {!rows.length && (
          <div
            className="px-2 py-3 text-11 italic text-label"
            style={status === "loading" ? { animation: "bePulse 1.6s ease infinite" } : undefined}
          >
            {status === "loading" ? "Loading index…" : "No folders in scope."}
          </div>
        )}

        <SectionLabel className="mx-1 mb-2 mt-4">Recent scans</SectionLabel>
        {indexes.map((e) => {
          const activeIndex = e.index_path === activeEntry?.index_path;
          return (
            <button
              key={e.index_path}
              type="button"
              onClick={() => {
                setIndexPath(e.index_path);
                setScopePath([]);
              }}
              className={`flex w-full items-center gap-1.5 rounded-[7px] border px-2 py-1.5 text-left text-115 transition-colors ${
                activeIndex
                  ? "border-primary-edge bg-primary-dim text-primary-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <HardDrive size={12} strokeWidth={2} className="flex-none text-history" aria-hidden />
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {e.root_path ? nodeName(e.root_path) : "index"}
              </span>
              <span className="mono flex-none text-105 text-dim">
                {scannedAgo(e.last_scanned_at)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
