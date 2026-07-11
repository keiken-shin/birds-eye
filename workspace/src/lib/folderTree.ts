// Build a hierarchical folder tree from the flat folder list returned by query_index.
// folders.total_bytes is the RECURSIVE subtree size (rolled up to every ancestor by the
// Rust writer), so each node is sized by its own total_bytes and ancestors are always present.

export type FolderRow = { path: string; total_files: number; total_bytes: number };

export type FolderNode = {
  path: string;
  name: string;
  bytes: number;
  files: number;
  childrenPaths: string[];
  hasChildren: boolean;
};

export type FolderTree = {
  rootPath: string | null;
  byPath: Map<string, FolderNode>;
  topLevel: FolderNode[];
};

function lastSep(p: string): number {
  return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
}

export function nodeName(path: string): string {
  const seg = path.split(/[\\/]/).filter(Boolean).pop();
  return seg ?? path;
}

/** Nearest existing ancestor of `path` within `set`, or null if none (top-level). */
function nearestParent(path: string, set: Set<string>): string | null {
  let prefix = path;
  for (;;) {
    const idx = lastSep(prefix);
    if (idx <= 0) return null;
    prefix = prefix.slice(0, idx);
    if (set.has(prefix)) return prefix;
    if (lastSep(prefix) < 0) return null;
  }
}

export function buildFolderTree(folders: FolderRow[], rootPath: string | null): FolderTree {
  const byPath = new Map<string, FolderNode>();
  const paths = folders.map((f) => f.path);
  const set = new Set(paths);

  for (const f of folders) {
    byPath.set(f.path, {
      path: f.path,
      name: nodeName(f.path),
      bytes: f.total_bytes,
      files: f.total_files,
      childrenPaths: [],
      hasChildren: false,
    });
  }

  const topLevel: FolderNode[] = [];
  for (const f of folders) {
    const parent = nearestParent(f.path, set);
    if (parent && byPath.has(parent)) {
      const p = byPath.get(parent)!;
      p.childrenPaths.push(f.path);
      p.hasChildren = true;
    } else {
      topLevel.push(byPath.get(f.path)!);
    }
  }

  const byBytesDesc = (a: FolderNode, b: FolderNode) => b.bytes - a.bytes;
  for (const node of byPath.values()) {
    node.childrenPaths.sort((a, b) => (byPath.get(b)?.bytes ?? 0) - (byPath.get(a)?.bytes ?? 0));
  }
  topLevel.sort(byBytesDesc);

  return { rootPath: rootPath && byPath.has(rootPath) ? rootPath : null, byPath, topLevel };
}

/** The folders to draw for the current scope: children of the deepest scope folder,
 *  or the root's children (or top-level) when at the root. */
export function scopeChildren(tree: FolderTree, scopePath: string[]): FolderNode[] {
  const current = scopePath[scopePath.length - 1] ?? tree.rootPath ?? null;
  if (current && tree.byPath.has(current)) {
    return tree.byPath
      .get(current)!
      .childrenPaths.map((p) => tree.byPath.get(p)!)
      .filter(Boolean);
  }
  return tree.topLevel;
}

/** Total bytes visible at the current scope (sum of the drawn children). */
export function scopeTotalBytes(children: FolderNode[]): number {
  return children.reduce((s, c) => s + c.bytes, 0);
}
