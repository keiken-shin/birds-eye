import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";

/**
 * Lets panel content render its own collapse control in its header (a floating
 * hover button on the resize handle read as bad UX). Null outside a SidePanel.
 */
const SidePanelContext = createContext<{ side: "left" | "right"; collapse: () => void } | null>(null);

export function useSidePanel() {
  return useContext(SidePanelContext);
}

/** Persisted width + collapsed state for a resizable side panel. */
export function usePanelState(storageKey: string, defaultWidth: number) {
  const [width, setWidth] = useState<number>(() => {
    const raw = localStorage.getItem(`${storageKey}.w`);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : defaultWidth;
  });
  const [collapsed, setCollapsed] = useState<boolean>(
    () => localStorage.getItem(`${storageKey}.hidden`) === "1"
  );
  useEffect(() => {
    localStorage.setItem(`${storageKey}.w`, String(Math.round(width)));
  }, [storageKey, width]);
  useEffect(() => {
    localStorage.setItem(`${storageKey}.hidden`, collapsed ? "1" : "0");
  }, [storageKey, collapsed]);
  return { width, setWidth, collapsed, setCollapsed };
}

export type SidePanelProps = {
  side: "left" | "right";
  width: number;
  onWidth: (w: number) => void;
  collapsed: boolean;
  onToggle: () => void;
  /** Accessible name — also the tooltip on the expand strip. */
  label: string;
  min?: number;
  max?: number;
  children: ReactNode;
};

/**
 * Resizable, collapsible workspace side panel. Drag the inner edge to resize
 * (double-click it to collapse); when collapsed, a slim strip re-expands it.
 */
export function SidePanel({
  side,
  width,
  onWidth,
  collapsed,
  onToggle,
  label,
  min = 170,
  max = 460,
  children,
}: SidePanelProps) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startW: number } | null>(null);

  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { startX: e.clientX, startW: width };
      setDragging(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [width]
  );
  const onHandleMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const next = side === "left" ? d.startW + dx : d.startW - dx;
      onWidth(Math.min(max, Math.max(min, next)));
    },
    [side, min, max, onWidth]
  );
  const onHandleUp = useCallback(() => {
    drag.current = null;
    setDragging(false);
  }, []);

  const ctx = useMemo(() => ({ side, collapse: onToggle }), [side, onToggle]);

  if (collapsed) {
    const OpenIcon = side === "left" ? PanelLeftOpen : PanelRightOpen;
    return (
      <button
        type="button"
        onClick={onToggle}
        title={`Show ${label}`}
        aria-label={`Show ${label}`}
        className={`flex w-6 flex-none items-start justify-center bg-panel pt-3 text-label transition-colors hover:bg-inset hover:text-ink ${
          side === "left" ? "border-r border-line" : "border-l border-line"
        }`}
      >
        <OpenIcon size={14} strokeWidth={1.8} aria-hidden />
      </button>
    );
  }

  // Collapse lives in the panel content's own header (via context); the handle
  // only resizes (drag) and collapses on double-click.
  const handle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      title={`Drag to resize · double-click to hide ${label}`}
      onPointerDown={onHandleDown}
      onPointerMove={onHandleMove}
      onPointerUp={onHandleUp}
      onDoubleClick={onToggle}
      className={`w-[5px] flex-none cursor-col-resize ${
        dragging ? "bg-primary-edge" : "bg-transparent hover:bg-line-strong"
      } transition-colors`}
    />
  );

  return (
    <div className="flex min-h-0 flex-none" style={{ width }}>
      {side === "right" ? handle : null}
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col bg-panel ${
          side === "left" ? "border-r border-line" : "border-l border-line"
        }`}
      >
        <SidePanelContext.Provider value={ctx}>{children}</SidePanelContext.Provider>
      </div>
      {side === "left" ? handle : null}
    </div>
  );
}
