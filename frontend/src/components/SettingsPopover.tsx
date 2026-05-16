import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { useScanContext } from "../context/ScanContext";

type Theme = "dark" | "light" | "system";
type Layer = "main" | "shortcuts";

const mono = "font-mono text-[11px] uppercase";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Ctrl+K", action: "Command palette" },
  { keys: "Ctrl+/", action: "Focus search" },
  { keys: "Esc", action: "Close overlay / cancel" },
  { keys: "↑ ↓", action: "Navigate results" },
  { keys: "Enter", action: "Open focused file" },
];

export function SettingsPopover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [layer, setLayer] = useState<Layer>("main");
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useScanContext();

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
        setLayer("main");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (v) setLayer("main");
      return !v;
    });
  }, []);

  return (
    <div className="relative" ref={triggerRef}>
      <div onClick={toggle}>{children}</div>
      {open && (
        <div
          ref={panelRef}
          className="absolute bottom-[calc(100%+10px)] right-0 w-[280px] border border-white/12 bg-[#0d0f11] shadow-[0_-8px_32px_rgba(0,0,0,0.6)] overflow-hidden"
          role="dialog"
          aria-label="Settings"
        >
          {/* Sliding container: two layers side by side */}
          <div
            className="flex transition-transform duration-200 ease-in-out"
            style={{ transform: layer === "shortcuts" ? "translateX(-50%)" : "translateX(0)", width: "200%" }}
          >
            {/* Layer 1: Main settings */}
            <div style={{ width: "280px" }} className="shrink-0">
              <div className="border-b border-white/7 px-[14px] py-[10px]">
                <span className={`${mono} tracking-[2px] text-white/50`}>Settings</span>
              </div>

              <div className="px-[14px] py-[12px] grid gap-[14px]">
                {/* Theme */}
                <div>
                  <span className="font-mono text-[10px] uppercase tracking-[1.5px] text-white/30 block mb-[8px]">Theme</span>
                  <div className="flex gap-[4px]">
                    {(["dark", "light", "system"] as Theme[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTheme(t)}
                        className={`flex-1 border py-[6px] font-mono text-[10px] uppercase transition-colors ${
                          theme === t
                            ? "border-[#00d0c4]/40 bg-[#00d0c4]/10 text-[#00d0c4]"
                            : "border-white/10 text-white/30 hover:border-white/20 hover:text-white/50"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Keyboard shortcuts row */}
              <button
                type="button"
                onClick={() => setLayer("shortcuts")}
                className="w-full flex items-center justify-between border-t border-white/7 px-[14px] py-[12px] hover:bg-white/[0.04] transition-colors"
              >
                <span className={`${mono} text-white/40`}>Keyboard Shortcuts</span>
                <ChevronRight size={13} className="text-white/25" />
              </button>
            </div>

            {/* Layer 2: Keyboard shortcuts */}
            <div style={{ width: "280px" }} className="shrink-0">
              <div className="flex items-center gap-[8px] border-b border-white/7 px-[14px] py-[10px]">
                <button
                  type="button"
                  onClick={() => setLayer("main")}
                  className="text-white/30 hover:text-white/60"
                  aria-label="Back to settings"
                >
                  <ArrowLeft size={13} />
                </button>
                <span className={`${mono} tracking-[2px] text-white/50`}>Keyboard Shortcuts</span>
              </div>

              <div className="px-[14px] py-[10px] grid gap-[2px]">
                {SHORTCUTS.map(({ keys, action }) => (
                  <div key={keys} className="flex items-center justify-between py-[6px] border-b border-white/5 last:border-0">
                    <span className="font-mono text-[10px] bg-white/8 px-[8px] py-[3px] text-[#f4f1ea]/60">{keys}</span>
                    <span className={`${mono} text-white/30`}>{action}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
