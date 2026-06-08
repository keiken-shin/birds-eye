import { useEffect, useMemo, useRef, useState } from "react";
import { categories, formatBytes, lastSegment, type CategoryKey, type FolderStats } from "../domain";
import { REASON_LABELS, type NativeTreemapLensFolder } from "../nativeClient";

type TreemapFolder = FolderStats & { displayBytes: number };
export type TreemapLens = "size" | "role" | "replaceability" | "lifecycle" | "reclaimableMass";
export type TreemapLensMap = Record<string, NativeTreemapLensFolder>;

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
  lensLabel: string;
  reclaimableBytes: number;
};

const LENSES: Array<{ id: TreemapLens; label: string }> = [
  { id: "size", label: "Size" },
  { id: "role", label: "Role" },
  { id: "replaceability", label: "Replaceability" },
  { id: "lifecycle", label: "Lifecycle" },
  { id: "reclaimableMass", label: "Reclaimable Mass" },
];

export function TreemapCanvas({
  folders,
  lens = "size",
  lensData = {},
  onLensChange,
  onSelect,
}: {
  folders: TreemapFolder[];
  lens?: TreemapLens;
  lensData?: TreemapLensMap;
  onLensChange?: (lens: TreemapLens) => void;
  onSelect?: (folder: TreemapFolder) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rectsRef = useRef<Rect[]>([]);
  const [size, setSize] = useState({ width: 800, height: 428 });
  const [hover, setHover] = useState<HoverState | null>(null);

  const rects = useMemo(() => {
    const sorted = [...folders].filter((folder) => folder.displayBytes > 0).sort((a, b) => b.displayBytes - a.displayBytes);
    return layoutTreemap(sorted, 0, 0, size.width, size.height, lens, lensData);
  }, [folders, lens, lensData, size.height, size.width]);

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
    <div className="relative min-h-[360px] overflow-hidden border border-primary/10 bg-base" ref={wrapRef}>
      <div className="absolute left-3 top-3 z-[3] flex max-w-[calc(100%-24px)] flex-wrap gap-1 border border-white/15 bg-base/85 p-1 backdrop-blur">
        {LENSES.map((item) => (
          <button
            key={item.id}
            className={`min-h-7 border px-2.5 font-mono text-10 font-black uppercase ${
              lens === item.id
                ? "border-primary/55 bg-primary/15 text-primary"
                : "border-transparent text-muted hover:border-white/15 hover:text-primary"
            }`}
            type="button"
            onClick={() => onLensChange?.(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <canvas
        aria-label={`${LENSES.find((item) => item.id === lens)?.label ?? "Size"} treemap`}
        className="block min-h-[360px] w-full cursor-pointer"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const bounds = canvas.getBoundingClientRect();
          const x = event.clientX - bounds.left;
          const y = event.clientY - bounds.top;
          const rect = rectsRef.current.find((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height);
          setHover(
            rect
              ? {
                  x,
                  y,
                  folder: rect.folder,
                  lensLabel: lensLabelFor(rect.folder.path, lens, lensData),
                  reclaimableBytes: lensData[rect.folder.path]?.reclaimable_bytes ?? 0,
                }
              : null
          );
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
        <div
          className="pointer-events-none absolute z-[4] grid max-w-80 gap-1 border border-primary/30 bg-base/95 px-3 py-2.5 text-xs text-primary shadow-[0_18px_48px_rgba(0,0,0,0.42)]"
          style={{ left: hover.x + 14, top: hover.y + 14 }}
        >
          <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{hover.folder.path}</strong>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{formatBytes(hover.folder.displayBytes)}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{hover.lensLabel}</span>
          {lens === "reclaimableMass" && (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {formatBytes(hover.reclaimableBytes)} reclaimable
            </span>
          )}
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{hover.folder.files.toLocaleString()} files</span>
        </div>
      )}
    </div>
  );
}

function layoutTreemap(
  folders: TreemapFolder[],
  x: number,
  y: number,
  width: number,
  height: number,
  lens: TreemapLens,
  lensData: TreemapLensMap,
): Rect[] {
  const total = folders.reduce((sum, folder) => sum + folder.displayBytes, 0);
  if (folders.length === 0 || total <= 0 || width <= 0 || height <= 0) return [];
  if (folders.length === 1) {
    return [{ x, y, width, height, folder: folders[0], color: colorForFolder(folders[0], lens, lensData) }];
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
      ...layoutTreemap(first, x, y, firstWidth, height, lens, lensData),
      ...layoutTreemap(second, x + firstWidth, y, width - firstWidth, height, lens, lensData),
    ];
  }

  const firstHeight = Math.max(1, Math.round(height * firstShare));
  return [
    ...layoutTreemap(first, x, y, width, firstHeight, lens, lensData),
    ...layoutTreemap(second, x, y + firstHeight, width, height - firstHeight, lens, lensData),
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

export function colorForFolder(folder: FolderStats, lens: TreemapLens, lensData: TreemapLensMap) {
  const data = lensData[folder.path];
  if (lens === "size") return categories[getDominantCategory(folder)].color;
  if (lens === "role") return ROLE_COLORS[data?.role ?? ""] ?? NO_DATA_COLOR;
  if (lens === "replaceability") return REPLACEABILITY_COLORS[data?.replaceability ?? ""] ?? NO_DATA_COLOR;
  if (lens === "lifecycle") return LIFECYCLE_COLORS[data?.lifecycle ?? ""] ?? NO_DATA_COLOR;
  if (data && data.reclaimable_bytes > 0) return RECLAIMABLE_COLORS[data.cleanup_reason ?? ""] ?? "#7dd3fc";
  return "rgba(148, 163, 184, 0.28)";
}

function lensLabelFor(folderPath: string, lens: TreemapLens, lensData: TreemapLensMap) {
  const data = lensData[folderPath];
  if (lens === "size") return "Size by dominant media";
  if (!data) return "No ontology data";
  if (lens === "role") return data.role ? `Role: ${data.role}` : "Role: unclassified";
  if (lens === "replaceability") {
    return data.replaceability ? `Replaceability: ${data.replaceability}` : "Replaceability: unknown";
  }
  if (lens === "lifecycle") return data.lifecycle ? `Lifecycle: ${data.lifecycle}` : "Lifecycle: none";
  return data.cleanup_reason
    ? `${REASON_LABELS[data.cleanup_reason] ?? data.cleanup_reason}`
    : "No cleanup-eligible mass";
}

const NO_DATA_COLOR = "#cbd5e1";

const ROLE_COLORS: Record<string, string> = {
  source: "#38bdf8",
  derivative: "#22c55e",
  reference: "#fb923c",
  asset: "#a78bfa",
  tool: "#14b8a6",
  backup: "#94a3b8",
  scratch: "#facc15",
  system: "#475569",
};

const REPLACEABILITY_COLORS: Record<string, string> = {
  irreplaceable: "#ef4444",
  "recoverable-with-effort": "#f97316",
  redownloadable: "#eab308",
  regenerable: "#22c55e",
};

const LIFECYCLE_COLORS: Record<string, string> = {
  active: "#3b82f6",
  finished: "#16a34a",
  abandoned: "#64748b",
  archived: "#94a3b8",
  planning: "#7dd3fc",
};

const RECLAIMABLE_COLORS: Record<string, string> = {
  "safe-derivative": "#22c55e",
  "redundant-backup": "#38bdf8",
  scratch: "#facc15",
  "finished-project-cruft": "#f97316",
};


