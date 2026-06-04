import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { useScanContext } from "../context/ScanContext";
import { useOntologyStatus } from "../hooks/useOntology";
import { setOntologyEnabled } from "../nativeClient";

type Theme = "dark" | "light" | "system";
type Layer = "main" | "shortcuts";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Ctrl+K", action: "Command palette" },
  { keys: "Esc", action: "Close overlay / cancel" },
  { keys: "↑ ↓", action: "Navigate results" },
];

export function SettingsPopover({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [layer, setLayer] = useState<Layer>("main");
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme, workspaceIndexPath, setRuntimeMessage } = useScanContext();
  const { status: ontologyStatusValue, refresh: refreshOntologyStatus } = useOntologyStatus(workspaceIndexPath);
  const [ontologyBusy, setOntologyBusy] = useState(false);
  const [quiet, setQuiet] = useState(() => localStorage.getItem("be.ontology.quiet") === "1");
  const [retentionDays, setRetentionDays] = useState(
    () => localStorage.getItem("be.ontology.retentionDays") ?? "90"
  );

  const toggleQuiet = useCallback((checked: boolean) => {
    setQuiet(checked);
    localStorage.setItem("be.ontology.quiet", checked ? "1" : "0");
  }, []);

  const changeRetention = useCallback((value: string) => {
    setRetentionDays(value);
    localStorage.setItem("be.ontology.retentionDays", value);
  }, []);

  const toggleOntology = useCallback(
    async (enabled: boolean) => {
      if (!workspaceIndexPath) return;
      setOntologyBusy(true);
      try {
        await setOntologyEnabled(workspaceIndexPath, enabled);
        await refreshOntologyStatus();
      } catch (e) {
        setRuntimeMessage(`Ontology toggle failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setOntologyBusy(false);
      }
    },
    [workspaceIndexPath, refreshOntologyStatus, setRuntimeMessage]
  );

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
          className="absolute bottom-[calc(100%+10px)] right-0 w-[280px] border border-white/12 bg-surface shadow-inner overflow-hidden"
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
              <div className="border-b border-white/7 px-3.5 py-2.5">
                <span className={`mono tracking-[2px] text-white/50`}>Settings</span>
              </div>

              <div className="px-3.5 py-[12px] grid gap-3.5">
                {/* Theme */}
                <div>
                  <span className="font-mono text-10 uppercase tracking-[1.5px] text-white/30 block mb-[8px]">Theme</span>
                  <div className="flex gap-[4px]">
                    {(["dark", "light", "system"] as Theme[]).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTheme(t)}
                        className={`flex-1 border py-[6px] font-mono !text-xs uppercase transition-colors ${
                          theme === t
                            ? "border-accent/40 bg-accent/10 text-accent"
                            : "border-white/10 text-white/30 hover:border-white/20 hover:text-white/50"
                        }`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* --- Ontology (Cleanup Intelligence) --- */}
                <div className="grid gap-2 border-t border-white/10 pt-3">
                  <span className="font-mono text-10 uppercase tracking-[1.5px] text-white/30">Cleanup Intelligence</span>

                  <label className="flex items-center justify-between gap-3 text-12 text-white/70">
                    Enabled
                    <input
                      type="checkbox"
                      disabled={!workspaceIndexPath || ontologyBusy}
                      checked={ontologyStatusValue?.enabled ?? false}
                      onChange={(e) => void toggleOntology(e.target.checked)}
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-12 text-white/70">
                    Quiet mode (hide discoveries)
                    <input
                      type="checkbox"
                      checked={quiet}
                      onChange={(e) => toggleQuiet(e.target.checked)}
                    />
                  </label>

                  <label className="flex items-center justify-between gap-3 text-12 text-white/70">
                    Recycle-bin retention (days)
                    <input
                      type="number"
                      min={1}
                      value={retentionDays}
                      onChange={(e) => changeRetention(e.target.value)}
                      className="w-20 border border-white/20 bg-transparent px-2 py-0.5 text-right text-white/80"
                    />
                  </label>
                </div>
              </div>

              {/* Keyboard shortcuts row */}
              <button
                type="button"
                onClick={() => setLayer("shortcuts")}
                className="w-full flex items-center justify-between border-t border-white/7 px-3.5 py-[12px] hover:bg-white/[0.04] transition-colors"
              >
                <span className={`mono text-white/40`}>Keyboard Shortcuts</span>
                <ChevronRight size={13} className="text-white/25" />
              </button>
            </div>

            {/* Layer 2: Keyboard shortcuts */}
            <div style={{ width: "280px" }} className="shrink-0">
              <div className="flex items-center gap-[8px] border-b border-white/7 px-3.5 py-2.5">
                <button
                  type="button"
                  onClick={() => setLayer("main")}
                  className="text-white/30 hover:text-white/60"
                  aria-label="Back to settings"
                >
                  <ArrowLeft size={13} />
                </button>
                <span className={`mono tracking-[2px] text-white/50`}>Keyboard Shortcuts</span>
              </div>

              <div className="px-3.5 py-2.5 grid gap-[2px]">
                {SHORTCUTS.map(({ keys, action }) => (
                  <div key={keys} className="flex items-center justify-between py-[6px] border-b border-white/5 last:border-0">
                    <span className="font-mono text-10 bg-white/8 px-[8px] py-[3px] text-primary/60">{keys}</span>
                    <span className={`mono text-white/30`}>{action}</span>
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




