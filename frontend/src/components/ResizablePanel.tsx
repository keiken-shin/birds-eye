import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface PanelEntry {
  id: string;
  defaultSize: number;
  minSize: number;
  collapsible: boolean;
}

interface GroupCtx {
  groupId: string;
  sizes: Map<string, number>;
  collapsed: Set<string>;
  registerPanel: (entry: PanelEntry) => void;
  startResize: (leftPanelId: string, startClientX: number) => void;
  expand: (panelId: string) => void;
}

const Ctx = createContext<GroupCtx | null>(null);

function useGroup(): GroupCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("Must be inside ResizablePanelGroup");
  return ctx;
}

interface GroupProps {
  id: string;
  children: ReactNode;
  className?: string;
}

export function ResizablePanelGroup({ id, children, className }: GroupProps) {
  const panels = useRef<Map<string, PanelEntry>>(new Map());
  const [sizes, setSizes] = useState<Map<string, number>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const registerPanel = useCallback(
    (entry: PanelEntry) => {
      if (panels.current.has(entry.id)) return;
      panels.current.set(entry.id, entry);
      setSizes((prev) => {
        if (prev.has(entry.id)) return prev;
        const saved = localStorage.getItem(`rp:${id}:${entry.id}`);
        const size = saved !== null ? Number(saved) : entry.defaultSize;
        return new Map(prev).set(entry.id, size);
      });
    },
    [id]
  );

  const startResize = useCallback(
    (leftPanelId: string, startClientX: number) => {
      let lastX = startClientX;

      const onMove = (e: PointerEvent) => {
        const delta = e.clientX - lastX;
        lastX = e.clientX;
        setSizes((prev) => {
          const panel = panels.current.get(leftPanelId);
          if (!panel) return prev;
          const current = prev.get(leftPanelId) ?? panel.defaultSize;
          const next = new Map(prev);

          if (panel.collapsible && current + delta < panel.minSize / 2) {
            const lastGood = current > 0 ? current : panel.defaultSize;
            localStorage.setItem(`rp:${id}:${leftPanelId}:last`, String(lastGood));
            next.set(leftPanelId, 0);
            setCollapsed((c) => new Set(c).add(leftPanelId));
            localStorage.setItem(`rp:${id}:${leftPanelId}`, "0");
          } else {
            const clamped = Math.max(panel.minSize, current + delta);
            next.set(leftPanelId, clamped);
            setCollapsed((c) => {
              const s = new Set(c);
              s.delete(leftPanelId);
              return s;
            });
            localStorage.setItem(`rp:${id}:${leftPanelId}`, String(clamped));
          }
          return next;
        });
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [id]
  );

  const expand = useCallback(
    (panelId: string) => {
      const panel = panels.current.get(panelId);
      if (!panel) return;
      const saved = localStorage.getItem(`rp:${id}:${panelId}:last`);
      const size = saved !== null ? Number(saved) : panel.defaultSize;
      setSizes((prev) => new Map(prev).set(panelId, size));
      setCollapsed((prev) => {
        const s = new Set(prev);
        s.delete(panelId);
        return s;
      });
      localStorage.setItem(`rp:${id}:${panelId}`, String(size));
    },
    [id]
  );

  return (
    <Ctx.Provider value={{ groupId: id, sizes, collapsed, registerPanel, startResize, expand }}>
      <div className={`flex ${className ?? ""}`}>{children}</div>
    </Ctx.Provider>
  );
}

interface PanelProps {
  id: string;
  defaultSize?: number;
  minSize?: number;
  collapsible?: boolean;
  flex?: boolean;
  children: ReactNode;
  className?: string;
}

export function ResizablePanel({
  id,
  defaultSize = 200,
  minSize = 100,
  collapsible = false,
  flex = false,
  children,
  className,
}: PanelProps) {
  const { registerPanel, sizes, collapsed } = useGroup();

  useEffect(() => {
    registerPanel({ id, defaultSize, minSize, collapsible });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (flex) {
    return (
      <div className={`min-w-0 flex-1 ${className ?? ""}`}>{children}</div>
    );
  }

  const isCollapsed = collapsed.has(id);
  const width = isCollapsed ? 0 : (sizes.get(id) ?? defaultSize);

  return (
    <div style={{ width, flexShrink: 0, overflow: "hidden" }}>
      <div className={className}>{!isCollapsed && children}</div>
    </div>
  );
}

interface HandleProps {
  leftPanelId: string;
}

export function ResizablePanelHandle({ leftPanelId }: HandleProps) {
  const { startResize } = useGroup();
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-white/10 transition-colors hover:bg-primary/50 active:bg-primary/70"
      onPointerDown={(e) => {
        e.preventDefault();
        startResize(leftPanelId, e.clientX);
      }}
    />
  );
}

export function useCollapsedPanel(panelId: string) {
  const { collapsed, expand } = useGroup();
  return {
    isCollapsed: collapsed.has(panelId),
    expand: () => expand(panelId),
  };
}
