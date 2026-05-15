import { useEffect, useMemo, useRef, useState } from "react";
import { categories, formatBytes, lastSegment, type CategoryKey, type FolderStats } from "../domain";

type TreemapFolder = FolderStats & { displayBytes: number };

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
  folder: TreemapFolder;
  color: string;
};

type HoverState = {
  x: number;
  y: number;
  folder: TreemapFolder;
};

export function TreemapCanvas({ folders, onSelect }: { folders: TreemapFolder[]; onSelect?: (folder: TreemapFolder) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rectsRef = useRef<Rect[]>([]);
  const [size, setSize] = useState({ width: 800, height: 428 });
  const [hover, setHover] = useState<HoverState | null>(null);

  const rects = useMemo(() => {
    const sorted = [...folders].filter((folder) => folder.displayBytes > 0).sort((a, b) => b.displayBytes - a.displayBytes);
    return layoutTreemap(sorted, 0, 0, size.width, size.height);
  }, [folders, size.height, size.width]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.max(320, Math.floor(entry.contentRect.width));
      setSize({ width, height: Math.max(360, Math.floor(width * 0.45)) });
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    rectsRef.current = rects;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * pixelRatio);
    canvas.height = Math.floor(size.height * pixelRatio);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawTreemap(context, rects, size.width, size.height);
  }, [rects, size.height, size.width]);

  if (folders.length === 0) {
    return <div className="treemap-empty">No indexed folders yet</div>;
  }

  return (
    <div className="treemap-canvas-wrap" ref={wrapRef}>
      <canvas
        aria-label="Space distribution treemap"
        className="treemap-canvas"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const bounds = canvas.getBoundingClientRect();
          const x = event.clientX - bounds.left;
          const y = event.clientY - bounds.top;
          const rect = rectsRef.current.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
          setHover(rect ? { x, y, folder: rect.folder } : null);
        }}
        onClick={(event) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const bounds = canvas.getBoundingClientRect();
          const x = event.clientX - bounds.left;
          const y = event.clientY - bounds.top;
          const rect = rectsRef.current.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
          if (rect) onSelect?.(rect.folder);
        }}
        ref={canvasRef}
      />
      {hover && (
        <div className="treemap-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <strong>{hover.folder.path}</strong>
          <span>{formatBytes(hover.folder.displayBytes)}</span>
          <span>{hover.folder.files.toLocaleString()} files</span>
        </div>
      )}
    </div>
  );
}

function layoutTreemap(folders: TreemapFolder[], x: number, y: number, width: number, height: number): Rect[] {
  const total = folders.reduce((sum, folder) => sum + folder.displayBytes, 0);
  if (folders.length === 0 || total <= 0 || width <= 0 || height <= 0) return [];
  if (folders.length === 1) {
    return [{ x, y, width, height, folder: folders[0], color: categories[getDominantCategory(folders[0])].color }];
  }

  let splitIndex = 0;
  let running = 0;
  for (let index = 0; index < folders.length; index += 1) {
    running += folders[index].displayBytes;
    splitIndex = index + 1;
    if (running >= total / 2) break;
  }

  const first = folders.slice(0, splitIndex);
  const second = folders.slice(splitIndex);
  const firstShare = running / total;

  if (width >= height) {
    const firstWidth = Math.max(1, Math.round(width * firstShare));
    return [
      ...layoutTreemap(first, x, y, firstWidth, height),
      ...layoutTreemap(second, x + firstWidth, y, width - firstWidth, height),
    ];
  }

  const firstHeight = Math.max(1, Math.round(height * firstShare));
  return [
    ...layoutTreemap(first, x, y, width, firstHeight),
    ...layoutTreemap(second, x, y + firstHeight, width, height - firstHeight),
  ];
}

function drawTreemap(context: CanvasRenderingContext2D, rects: Rect[], width: number, height: number) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "rgba(5, 6, 7, 0.88)";
  context.fillRect(0, 0, width, height);

  context.strokeStyle = "rgba(244, 241, 234, 0.08)";
  context.lineWidth = 1;
  for (let x = 24; x < width; x += 24) {
    for (let y = 24; y < height; y += 24) {
      context.beginPath();
      context.arc(x, y, 1, 0, Math.PI * 2);
      context.stroke();
    }
  }

  for (const rect of rects) {
    const inset = 2;
    const x = rect.x + inset;
    const y = rect.y + inset;
    const w = Math.max(0, rect.width - inset * 2);
    const h = Math.max(0, rect.height - inset * 2);
    if (w <= 0 || h <= 0) continue;

    context.fillStyle = makeStorageFill(rect.color, context, x, y, w, h);
    context.fillRect(x, y, w, h);
    context.strokeStyle = "rgba(244, 241, 234, 0.22)";
    context.strokeRect(x, y, w, h);

    context.fillStyle = rect.color;
    context.globalAlpha = 0.72;
    context.fillRect(x, y, Math.min(w, 4), Math.min(h, 22));
    context.globalAlpha = 1;

    if (w > 72 && h > 42) {
      context.fillStyle = "rgba(244, 241, 234, 0.92)";
      context.font = "800 12px Inter, Segoe UI, sans-serif";
      context.fillText(trimToWidth(context, lastSegment(rect.folder.path), w - 14), x + 8, y + h - 24);
      context.fillStyle = "rgba(244, 241, 234, 0.62)";
      context.font = "11px Consolas, Liberation Mono, monospace";
      context.fillText(formatBytes(rect.folder.displayBytes), x + 8, y + h - 8);
    } else if (w > 44 && h > 24) {
      context.fillStyle = "rgba(244, 241, 234, 0.88)";
      context.font = "800 10px Inter, Segoe UI, sans-serif";
      context.fillText(trimToWidth(context, lastSegment(rect.folder.path), w - 8), x + 4, y + h - 7);
    }
  }
}

function makeStorageFill(
  color: string,
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const gradient = context.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, "rgba(244, 241, 234, 0.18)");
  gradient.addColorStop(0.08, color);
  gradient.addColorStop(0.09, "rgba(30, 33, 37, 0.92)");
  gradient.addColorStop(1, "rgba(8, 10, 13, 0.94)");
  return gradient;
}

function trimToWidth(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let trimmed = text;
  while (trimmed.length > 3 && context.measureText(`${trimmed}...`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}...`;
}

function getDominantCategory(folder: FolderStats): CategoryKey {
  return (Object.keys(folder.categories) as CategoryKey[]).reduce((best, key) => {
    return folder.categories[key] > folder.categories[best] ? key : best;
  }, "other");
}
