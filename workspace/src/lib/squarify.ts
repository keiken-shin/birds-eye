// Squarified treemap layout — ported from docs/goal/Birds Eye Workspace.dc.html.
// Produces rectangles with low aspect ratios so labels stay readable.

export type SquarifyInput<T> = { ref: T; value: number };
export type SquarifyRect<T> = { ref: T; x: number; y: number; w: number; h: number };

function worstRatio<T>(row: Array<{ ref: T; value: number; area: number }>, length: number): number {
  const sum = row.reduce((s, n) => s + n.area, 0);
  if (sum <= 0) return Infinity;
  const mx = Math.max(...row.map((n) => n.area));
  const mn = Math.min(...row.map((n) => n.area));
  const s2 = sum * sum;
  const l2 = length * length;
  return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
}

export function squarify<T>(
  items: Array<SquarifyInput<T>>,
  x: number,
  y: number,
  w: number,
  h: number
): Array<SquarifyRect<T>> {
  const out: Array<SquarifyRect<T>> = [];
  const nodes = items
    .filter((i) => i.value > 0)
    .map((i) => ({ ref: i.ref, value: i.value, area: 0 }));
  if (!nodes.length || w <= 0 || h <= 0) return out;

  const total = nodes.reduce((s, n) => s + n.value, 0) || 1;
  const scale = (w * h) / total;
  nodes.forEach((n) => (n.area = n.value * scale));

  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  let i = 0;
  while (i < nodes.length) {
    const shortest = Math.min(rw, rh);
    let row = [nodes[i]];
    let j = i + 1;
    let best = worstRatio(row, shortest);
    while (j < nodes.length) {
      const next = row.concat(nodes[j]);
      const nw = worstRatio(next, shortest);
      if (nw > best) break;
      row = next;
      best = nw;
      j++;
    }
    const rowArea = row.reduce((s, n) => s + n.area, 0);
    if (rw >= rh) {
      const colW = rowArea / rh || 0;
      let yy = ry;
      row.forEach((n) => {
        const ch = n.area / (colW || 1);
        out.push({ ref: n.ref, x: rx, y: yy, w: colW, h: ch });
        yy += ch;
      });
      rx += colW;
      rw -= colW;
    } else {
      const rowH = rowArea / rw || 0;
      let xx = rx;
      row.forEach((n) => {
        const cw = n.area / (rowH || 1);
        out.push({ ref: n.ref, x: xx, y: ry, w: cw, h: rowH });
        xx += cw;
      });
      ry += rowH;
      rh -= rowH;
    }
    i = j;
  }
  return out;
}
