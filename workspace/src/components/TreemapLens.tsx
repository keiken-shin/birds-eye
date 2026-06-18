import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { scopeChildren, type FolderNode } from "../lib/folderTree";
import { squarify } from "../lib/squarify";
import { NEUTRAL_STYLE, VERDICT_STYLES, verdictForFolder } from "../lib/verdict";

const GAP = 3;

export function TreemapLens() {
  const { tree, lensByPath } = useIndexData();
  const { scopePath, selected, ontologyEnabled, select, drillInto, isStaged } = useWorkspace();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 640, h: 560 });
  const [hover, setHover] = useState<string | null>(null);

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

  const children = useMemo(() => (tree ? scopeChildren(tree, scopePath) : []), [tree, scopePath]);
  const rects = useMemo(
    () => squarify(children.map((c) => ({ ref: c, value: c.bytes })), 0, 0, size.w, size.h),
    [children, size.w, size.h]
  );

  return (
    <div ref={wrapRef} className="relative m-4 min-h-0 flex-1">
      {rects.map(({ ref: node, x, y, w, h }) => {
        const lensRow = lensByPath.get(node.path);
        const verdict = ontologyEnabled && lensRow ? verdictForFolder(lensRow) : null;
        const style = verdict ? VERDICT_STYLES[verdict] : NEUTRAL_STYLE;
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
            onMouseLeave={() => setHover((h) => (h === node.path ? null : h))}
            className="absolute cursor-pointer overflow-hidden rounded-[6px] p-2"
            style={{
              left: x + GAP / 2,
              top: y + GAP / 2,
              width: Math.max(0, w - GAP),
              height: Math.max(0, h - GAP),
              border: "1px solid " + (staged ? "#3ddc84" : style.bd),
              background: style.bg,
              color: style.tx,
              filter: hovered ? "brightness(1.35)" : "none",
              boxShadow: sel ? "0 0 0 2px #3ddc84, 0 0 22px rgba(61,220,132,.22)" : "none",
              zIndex: sel ? 3 : hovered ? 2 : 1,
              transition: "filter .12s, box-shadow .12s",
            }}
          >
            {showLabel && (
              <div>
                <div className="flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-12 font-medium">
                  {node.name}
                </div>
                <div className="mono mt-px text-[10.5px] opacity-80">{formatBytes(node.bytes)}</div>
              </div>
            )}
            {(staged || (reclaimable > 0 && showLabel)) && (
              <div
                className="absolute right-[7px] top-[7px] flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px]"
                style={
                  staged
                    ? { background: "#3ddc84", color: "#06140c" }
                    : { background: "rgba(61,220,132,.16)", color: "#7fe0a6", border: "1px solid rgba(61,220,132,.3)" }
                }
              >
                {staged ? "✓" : "↑"}
              </div>
            )}
            {hovered && node.hasChildren && showLabel && (
              <div className="absolute bottom-2 right-[9px] rounded-[5px] bg-black/40 px-1.5 py-0.5 text-10 text-muted">
                ⤢ open
              </div>
            )}
          </div>
        );
      })}

      {!rects.length && (
        <div className="flex h-full items-center justify-center text-12 italic text-label">
          {tree
            ? "No subfolders at this scope — select a parent or scan a folder with nested directories."
            : "Scan a folder to see its storage map."}
        </div>
      )}
    </div>
  );
}

export type { FolderNode };
