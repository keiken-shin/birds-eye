import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Maximize2, ScanLine } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { nodeName, scopeChildren, scopeTotalBytes, type FolderNode } from "../../lib/folderTree";
import { squarify } from "../../lib/squarify";
import { NEUTRAL_STYLE, VERDICT_STYLES, verdictForFolder } from "../../lib/verdict";
import { CATEGORIES, categoryOf, type MediaKind } from "../../lib/categories";
import { EmptyState } from "../ui/Card";
import { Button } from "../ui/Button";
import type { Verdict } from "../../state/types";

const GAP = 3;
const MAX_TILES = 24;

type ColorMode = "type" | "safety";

type TileStyle = { bg: string; bd: string; tx: string };

function categoryStyle(kind: MediaKind): TileStyle {
  const color = CATEGORIES[kind].color;
  return {
    bg: `color-mix(in srgb, ${color} 14%, var(--color-window))`,
    bd: `color-mix(in srgb, ${color} 45%, transparent)`,
    tx: "var(--color-ink-soft)",
  };
}

export function TreemapView() {
  const { tree, lensByPath, status, error, refreshData, overview, reclaimableTotal, activeEntry } =
    useIndexData();
  const { scopePath, selected, ontologyEnabled, select, drillInto, popScopeTo, isStaged, setOverlay } =
    useWorkspace();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 640, h: 560 });
  const [hover, setHover] = useState<string | null>(null);
  const [mode, setMode] = useState<ColorMode | null>(null);
  const colorMode: ColorMode = mode ?? (ontologyEnabled ? "safety" : "type");

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const obs = new ResizeObserver(([entry]) => {
      setSize({
        w: Math.max(120, Math.floor(entry.contentRect.width)),
        h: Math.max(120, Math.floor(entry.contentRect.height)),
      });
    });
    obs.observe(wrap);
    return () => obs.disconnect();
  }, []);

  // Dominant media kind per folder → the "type" color channel.
  const dominantKind = useMemo(() => {
    const best = new Map<string, { kind: string; bytes: number }>();
    for (const fm of overview?.folder_media ?? []) {
      const prev = best.get(fm.folder_path);
      if (!prev || fm.total_bytes > prev.bytes) {
        best.set(fm.folder_path, { kind: fm.media_kind, bytes: fm.total_bytes });
      }
    }
    return best;
  }, [overview]);

  const children = useMemo(() => (tree ? scopeChildren(tree, scopePath) : []), [tree, scopePath]);
  const scopeTotal = scopeTotalBytes(children);

  // Aggregate the long tail into one "+N smaller" tile so the map stays legible.
  const { drawn, restCount, restBytes } = useMemo(() => {
    if (children.length <= MAX_TILES) return { drawn: children, restCount: 0, restBytes: 0 };
    const drawnChildren = children.slice(0, MAX_TILES);
    const rest = children.slice(MAX_TILES);
    return {
      drawn: drawnChildren,
      restCount: rest.length,
      restBytes: rest.reduce((s, c) => s + c.bytes, 0),
    };
  }, [children]);

  type Item = { kind: "folder"; node: FolderNode } | { kind: "rest" };
  const rects = useMemo(() => {
    const items: Array<{ ref: Item; value: number }> = drawn.map((node) => ({
      ref: { kind: "folder", node } as Item,
      value: node.bytes,
    }));
    if (restCount > 0) items.push({ ref: { kind: "rest" }, value: Math.max(1, restBytes) });
    return squarify(items, 0, 0, size.w, size.h);
  }, [drawn, restCount, restBytes, size.w, size.h]);

  // Breadcrumbs (moved here from the old CenterStage header).
  const rootName = activeEntry?.root_path ? nodeName(activeEntry.root_path) : "Storage";
  const rootIsScope0 = scopePath[0] === activeEntry?.root_path;
  const crumbs: Array<{ name: string; popTo: number }> = [{ name: rootName, popTo: rootIsScope0 ? 1 : 0 }];
  scopePath.forEach((p, i) => {
    if (i === 0 && rootIsScope0) return;
    crumbs.push({ name: nodeName(p), popTo: i + 1 });
  });

  const legend =
    colorMode === "safety"
      ? (Object.entries(VERDICT_STYLES) as Array<[Verdict, (typeof VERDICT_STYLES)[Verdict]]>).map(
          ([verdict, s]) => ({ key: verdict, label: s.label.split(" — ")[0], color: s.bd })
        )
      : Array.from(new Set(drawn.map((n) => (dominantKind.get(n.path)?.kind ?? "other") as MediaKind)))
          .slice(0, 7)
          .map((kind) => ({ key: kind, label: CATEGORIES[kind]?.label ?? kind, color: CATEGORIES[kind]?.color ?? CATEGORIES.other.color }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb + controls */}
      <div className="flex h-10 flex-none items-center gap-1.5 border-b border-line-soft px-3.5 text-12">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={i} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => popScopeTo(crumb.popTo)}
                className={last ? "font-semibold text-ink" : "text-faint hover:text-ink"}
              >
                {crumb.name}
              </button>
              {!last && <span className="text-line-strong">/</span>}
            </span>
          );
        })}
        <span className="ml-auto flex items-center gap-3">
          <span className="mono text-11 text-dim">{formatBytes(scopeTotal)}</span>
          {reclaimableTotal > 0 ? (
            <span className="text-11 text-primary-ink">{formatBytes(reclaimableTotal)} reclaimable</span>
          ) : null}
          <span className="flex gap-[2px] rounded-lg border border-line-input bg-field p-[2px] text-10">
            {(["type", "safety"] as ColorMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded-md px-2 py-1 font-medium tracking-wide uppercase transition-colors ${
                  colorMode === m ? "bg-primary text-on-primary" : "text-faint hover:text-ink"
                }`}
                title={m === "type" ? "Color by file type" : "Color by safety verdict"}
              >
                {m}
              </button>
            ))}
          </span>
        </span>
      </div>

      {/* Map */}
      <div ref={wrapRef} className="relative m-3 min-h-0 flex-1">
        {rects.map(({ ref: item, x, y, w, h }) => {
          if (item.kind === "rest") {
            return (
              <div
                key="__rest"
                className="absolute flex items-center justify-center overflow-hidden rounded-[6px] border border-dashed border-line-modal bg-panel text-center"
                style={{ left: x + GAP / 2, top: y + GAP / 2, width: Math.max(0, w - GAP), height: Math.max(0, h - GAP) }}
              >
                <div className="px-1 text-10 leading-tight text-label">
                  +{restCount} smaller
                  <div className="mono opacity-80">{formatBytes(restBytes)}</div>
                </div>
              </div>
            );
          }
          const node = item.node;
          const lensRow = lensByPath.get(node.path);
          const verdict = ontologyEnabled && lensRow ? verdictForFolder(lensRow) : null;
          const style: TileStyle =
            colorMode === "type"
              ? categoryStyle((dominantKind.get(node.path)?.kind ?? "other") as MediaKind)
              : verdict
                ? VERDICT_STYLES[verdict]
                : NEUTRAL_STYLE;
          const reclaimable = lensRow?.reclaimable_bytes ?? 0;
          const sel = selected?.path === node.path;
          const staged = isStaged(node.path);
          const hovered = hover === node.path;
          const showLabel = w - GAP > 58 && h - GAP > 30;

          return (
            <div
              key={node.path}
              onClick={() => select({ kind: "folder", path: node.path, name: node.name, bytes: node.bytes })}
              onDoubleClick={() => node.hasChildren && drillInto(node.path)}
              onMouseEnter={() => setHover(node.path)}
              onMouseLeave={() => setHover((prev) => (prev === node.path ? null : prev))}
              className="absolute cursor-pointer overflow-hidden rounded-[6px] p-2"
              style={{
                left: x + GAP / 2,
                top: y + GAP / 2,
                width: Math.max(0, w - GAP),
                height: Math.max(0, h - GAP),
                border: `1px solid ${staged ? "var(--color-primary)" : style.bd}`,
                background: style.bg,
                color: style.tx,
                filter: hovered ? "brightness(1.35)" : "none",
                boxShadow: sel
                  ? "0 0 0 2px var(--color-primary), 0 0 22px color-mix(in srgb, var(--color-primary) 22%, transparent)"
                  : "none",
                zIndex: sel ? 3 : hovered ? 2 : 1,
                transition: "filter .12s, box-shadow .12s",
              }}
            >
              {showLabel && (
                <div>
                  <div className="overflow-hidden text-12 font-medium text-ellipsis whitespace-nowrap">
                    {node.name}
                  </div>
                  <div className="mono mt-px text-105 opacity-80">{formatBytes(node.bytes)}</div>
                </div>
              )}
              {(staged || (reclaimable > 0 && showLabel)) && (
                <div
                  className="absolute top-[7px] right-[7px] flex h-[18px] w-[18px] items-center justify-center rounded-full"
                  style={
                    staged
                      ? { background: "var(--color-primary)", color: "var(--color-on-primary)" }
                      : {
                          background: "var(--color-primary-dim)",
                          color: "var(--color-primary-ink)",
                          border: "1px solid var(--color-primary-edge)",
                        }
                  }
                  title={staged ? "Staged for cleanup" : `${formatBytes(reclaimable)} reclaimable`}
                >
                  {staged ? <Check size={11} strokeWidth={3} /> : <ArrowUp size={11} strokeWidth={2.5} />}
                </div>
              )}
              {hovered && node.hasChildren && showLabel && (
                <div className="absolute right-[9px] bottom-2 flex items-center gap-1 rounded-[5px] bg-black/40 px-1.5 py-0.5 text-10 text-muted">
                  <Maximize2 size={9} aria-hidden /> open
                </div>
              )}
            </div>
          );
        })}

        {!rects.length &&
          (status === "loading" ? (
            <div className="flex h-full items-center justify-center">
              <span className="text-13 text-label" style={{ animation: "bePulse 1.6s ease infinite" }}>
                Loading index…
              </span>
            </div>
          ) : status === "error" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <div className="max-w-[440px] text-center text-12 leading-relaxed text-danger">
                Couldn't read this index: {error}
              </div>
              <Button onClick={() => void refreshData()}>Retry</Button>
            </div>
          ) : tree ? (
            <EmptyState
              icon={Maximize2}
              title="No subfolders at this scope"
              hint="Select a parent in the tree, or scan a folder with nested directories."
              className="h-full"
            />
          ) : (
            <EmptyState
              icon={ScanLine}
              title="No storage indexed yet"
              hint="Scan a folder or drive to map what's inside it — everything stays on this machine."
              action={{ label: "Scan a folder", onClick: () => setOverlay("scan") }}
              className="h-full"
            />
          ))}
      </div>

      {/* Legend */}
      {rects.length > 0 ? (
        <div className="flex h-8 flex-none items-center gap-4 border-t border-line-soft px-3.5">
          {legend.map((item) => (
            <span key={item.key} className="flex items-center gap-1.5 text-10 text-faint">
              <span className="h-2 w-2 rounded-[3px]" style={{ background: item.color }} />
              {item.label}
            </span>
          ))}
          <span className="ml-auto text-10 text-label">click select · double-click open · ⌫ up</span>
        </div>
      ) : null}
    </div>
  );
}
