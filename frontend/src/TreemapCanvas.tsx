import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { categories, formatBytes, lastSegment, type CategoryKey, type FileStats, type FolderStats } from "./domain";

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

export function TreemapCanvas({
  files = [],
  folders,
  nativeRuntime = false,
  onSelect,
}: {
  files?: FileStats[];
  folders: TreemapFolder[];
  nativeRuntime?: boolean;
  onSelect?: (folder: TreemapFolder) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rectsRef = useRef<Rect[]>([]);
  const filmstripCacheRef = useRef(new Map<string, FileStats[]>());
  const filmstripCacheLimit = 18;
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
      setSize({ width, height: Math.min(760, Math.max(420, Math.floor(width * 0.48))) });
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

  useEffect(() => {
    filmstripCacheRef.current.clear();
  }, [files]);

  const hoveredPath = hover?.folder.path ?? null;
  const filmstripSamples = useMemo(() => {
    if (!hoveredPath) return [];
    const cache = filmstripCacheRef.current;
    const cached = cache.get(hoveredPath);
    if (cached) {
      cache.delete(hoveredPath);
      cache.set(hoveredPath, cached);
      return cached;
    }

    const samples = files
      .filter((file) => (file.category === "photos" || file.category === "videos") && isPathInsideFolder(file.path, hoveredPath))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 4);
    cache.set(hoveredPath, samples);
    if (cache.size > filmstripCacheLimit) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey) cache.delete(oldestKey);
    }
    return samples;
  }, [files, hoveredPath]);

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
        <div className="treemap-tooltip" style={getTooltipPosition(hover.x, hover.y, size.width, size.height)}>
          <strong>{hover.folder.path}</strong>
          <span>{formatBytes(hover.folder.displayBytes)}</span>
          <span>{hover.folder.files.toLocaleString()} files</span>
          <FolderCategoryMix folder={hover.folder} />
          <FolderFilmstrip folder={hover.folder} samples={filmstripSamples} nativeRuntime={nativeRuntime} />
        </div>
      )}
    </div>
  );
}

function FolderCategoryMix({ folder }: { folder: TreemapFolder }) {
  const entries = (Object.keys(categories) as CategoryKey[])
    .map((key) => ({ key, bytes: folder.categories[key] }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 4);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="tooltip-category-mix">
      {entries.map((entry) => (
        <span key={entry.key}>
          <i style={{ background: categories[entry.key].color }} />
          {categories[entry.key].label} {formatBytes(entry.bytes)}
        </span>
      ))}
    </div>
  );
}

function FolderFilmstrip({ folder, samples, nativeRuntime }: { folder: TreemapFolder; samples: FileStats[]; nativeRuntime: boolean }) {
  const hasPreviewableMedia = folder.categories.photos > 0 || folder.categories.videos > 0;
  if (samples.length === 0) {
    return hasPreviewableMedia ? <span className="tooltip-preview-empty">No indexed media samples available for this folder</span> : null;
  }

  return (
    <div className="tooltip-filmstrip">
      {samples.map((file) => (
        <div className={`filmstrip-frame ${file.category}`} key={file.path}>
          {nativeRuntime && file.category === "photos" ? (
            <PreviewImage file={file} />
          ) : (
            <span title={lastSegment(file.path)}>{getFilmstripLabel(file)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function PreviewImage({ file }: { file: FileStats }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span title={lastSegment(file.path)}>Preview unavailable</span>;
  }

  return <img src={toAssetUrl(file.path)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function getFilmstripLabel(file: FileStats) {
  if (file.category === "videos") {
    return `Video ${lastSegment(file.path)}`;
  }
  return lastSegment(file.path);
}

function getTooltipPosition(x: number, y: number, width: number, height: number) {
  return {
    left: x > width - 360 ? Math.max(8, x - 334) : x + 14,
    top: y > height - 190 ? Math.max(8, y - 174) : y + 14,
  };
}

function toAssetUrl(path: string) {
  return convertFileSrc(path);
}

function isPathInsideFolder(path: string, folder: string) {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedFolder = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
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
  context.fillStyle = "rgba(0, 0, 0, 0.24)";
  context.fillRect(0, 0, width, height);

  for (const rect of rects) {
    const inset = 2;
    const x = rect.x + inset;
    const y = rect.y + inset;
    const w = Math.max(0, rect.width - inset * 2);
    const h = Math.max(0, rect.height - inset * 2);
    if (w <= 0 || h <= 0) continue;

    const gradient = context.createLinearGradient(x, y, x + w, y + h);
    gradient.addColorStop(0, withAlpha(rect.color, 0.9));
    gradient.addColorStop(1, withAlpha(rect.color, 0.34));
    context.fillStyle = gradient;
    context.fillRect(x, y, w, h);
    drawCategoryBands(context, rect.folder, x, y, w, h);
    context.strokeStyle = "rgba(255, 255, 255, 0.18)";
    context.strokeRect(x, y, w, h);

    if (w > 72 && h > 42) {
      context.fillStyle = "rgba(255, 255, 255, 0.92)";
      context.font = "700 13px Inter, Segoe UI, sans-serif";
      context.fillText(trimToWidth(context, lastSegment(rect.folder.path), w - 14), x + 8, y + h - 24);
      context.fillStyle = "rgba(255, 255, 255, 0.72)";
      context.font = "12px Inter, Segoe UI, sans-serif";
      context.fillText(formatBytes(rect.folder.displayBytes), x + 8, y + h - 8);
    } else if (w > 44 && h > 24) {
      context.fillStyle = "rgba(255, 255, 255, 0.88)";
      context.font = "700 10px Inter, Segoe UI, sans-serif";
      context.fillText(trimToWidth(context, lastSegment(rect.folder.path), w - 8), x + 4, y + h - 7);
    }
  }
}

function drawCategoryBands(context: CanvasRenderingContext2D, folder: TreemapFolder, x: number, y: number, width: number, height: number) {
  const entries = (Object.keys(categories) as CategoryKey[])
    .map((key) => ({ key, bytes: folder.categories[key] }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (entries.length <= 1 || total <= 0 || width < 22 || height < 18) return;

  let offset = 0;
  const horizontal = width >= height;
  for (const entry of entries) {
    const share = entry.bytes / total;
    const band = Math.max(2, Math.round((horizontal ? width : height) * share));
    context.fillStyle = withAlpha(categories[entry.key].color, entry.key === entries[0].key ? 0.82 : 0.72);

    if (horizontal) {
      const bandWidth = Math.min(width - offset, band);
      context.fillRect(x + offset, y, bandWidth, height);
      offset += bandWidth;
    } else {
      const bandHeight = Math.min(height - offset, band);
      context.fillRect(x, y + offset, width, bandHeight);
      offset += bandHeight;
    }

    if (offset >= (horizontal ? width : height)) break;
  }

  context.fillStyle = "rgba(0, 0, 0, 0.1)";
  context.fillRect(x, y, width, height);
}

function withAlpha(hex: string, alpha: number) {
  const color = hex.replace("#", "");
  const red = parseInt(color.slice(0, 2), 16);
  const green = parseInt(color.slice(2, 4), 16);
  const blue = parseInt(color.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
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
