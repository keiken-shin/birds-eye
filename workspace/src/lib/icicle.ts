/**
 * Icicle layout for the Results lens. A flat result set (files with sizes, from
 * `search_files` / `run_saved_view`) is folded back into its path hierarchy and laid out as
 * stacked rows: depth = row, width ∝ subtree bytes. It complements the treemap — where the map
 * answers "what's big", the icicle answers "where in the tree the matches concentrate".
 *
 * Two pure steps so the geometry is unit-checkable without React:
 *   buildIcicle(rows)            → a prefix tree, bytes summed bottom-up, common prefix collapsed
 *   layoutIcicle(root, w, rowH)  → flat rects that partition each parent's width, no overlap
 */

export type IcicleInput = { path: string; size: number };

export type IcicleNode = {
  name: string;
  path: string;
  bytes: number;
  depth: number;
  isLeaf: boolean;
  children: IcicleNode[];
};

export type IcicleRect = {
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  name: string;
  path: string;
  bytes: number;
  isLeaf: boolean;
};

const SEP_RE = /[\\/]+/;

function segments(path: string): string[] {
  return path.split(SEP_RE).filter(Boolean);
}

/** Build a prefix tree from result paths; node.bytes is the sum of leaf sizes beneath it. */
export function buildIcicle(rows: IcicleInput[], rootLabel = "results"): IcicleNode {
  const sep = rows.some((r) => r.path.includes("\\")) ? "\\" : "/";
  const split = rows.map((r) => ({ segs: segments(r.path), size: Math.max(0, r.size) }));

  // Collapse the common leading segments shared by every row into the root, so a deep shared
  // ancestor (C:\Users\me\proj\…) doesn't render as a column of single-child rows.
  let common = 0;
  if (split.length) {
    const first = split[0].segs;
    outer: for (; common < first.length; common++) {
      const seg = first[common];
      for (const s of split) {
        // never consume a row's final segment as "common" — a leaf must stay a leaf
        if (common >= s.segs.length - 1 || s.segs[common] !== seg) break outer;
      }
    }
  }

  const rootName = common > 0 ? split[0].segs[common - 1] : rootLabel;
  const rootPath = common > 0 ? split[0].segs.slice(0, common).join(sep) : "";
  const root: IcicleNode = { name: rootName, path: rootPath, bytes: 0, depth: 0, isLeaf: false, children: [] };

  for (const { segs, size } of split) {
    let node = root;
    let acc = rootPath;
    for (let i = common; i < segs.length; i++) {
      const seg = segs[i];
      acc = acc ? acc + sep + seg : seg;
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = { name: seg, path: acc, bytes: 0, depth: node.depth + 1, isLeaf: false, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.isLeaf = node.children.length === 0;
    node.bytes += size; // size lands on the leaf; rolled up below
  }

  // Roll leaf bytes up to ancestors (post-order).
  const sum = (n: IcicleNode): number => {
    if (n.children.length === 0) return n.bytes;
    n.bytes = n.children.reduce((s, c) => s + sum(c), 0);
    return n.bytes;
  };
  sum(root);
  return root;
}

/**
 * Lay the tree out as an icicle. Each node's children partition the node's horizontal extent
 * proportional to bytes (largest first); y is fixed by depth. Rows below `maxDepth` are not
 * emitted — the node at maxDepth becomes the visual leaf — and zero-byte slivers are dropped.
 */
export function layoutIcicle(
  root: IcicleNode,
  width: number,
  rowHeight: number,
  maxDepth = 6
): IcicleRect[] {
  const rects: IcicleRect[] = [];

  const place = (node: IcicleNode, x: number, w: number) => {
    if (w <= 0 || node.bytes <= 0) return;
    rects.push({
      x,
      y: node.depth * rowHeight,
      w,
      h: rowHeight,
      depth: node.depth,
      name: node.name,
      path: node.path,
      bytes: node.bytes,
      isLeaf: node.isLeaf || node.depth >= maxDepth,
    });
    if (node.depth >= maxDepth) return;
    const kids = [...node.children].sort((a, b) => b.bytes - a.bytes);
    let cx = x;
    for (const child of kids) {
      const cw = (child.bytes / node.bytes) * w;
      place(child, cx, cw);
      cx += cw;
    }
  };

  place(root, 0, width);
  return rects;
}
