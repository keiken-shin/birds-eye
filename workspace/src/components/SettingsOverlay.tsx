import { useState } from "react";
import type { ScanStrategy } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { getDefaultStrategy, setDefaultStrategy } from "../lib/prefs";

const STRATEGIES: Array<{ id: ScanStrategy; title: string; note: string }> = [
  { id: "smart", title: "Smart (deep + dedup)", note: "full walk + content hashing · most accurate" },
  { id: "metadata", title: "Metadata only", note: "fast index without hashing · seconds" },
];

/**
 * Settings — deliberately small and honest. The app has no backend settings store, and the
 * theme is dark-only, so this holds the one real UI default the app can't derive: the strategy a
 * new scan starts on (persisted in localStorage, consumed by ScanOverlay). No accent/density
 * knobs — they'd only half-apply over the half-tokenized styles, which would be theater.
 */
export function SettingsOverlay() {
  const { overlay, setOverlay } = useWorkspace();
  const [strategy, setStrategy] = useState<ScanStrategy>(getDefaultStrategy);

  if (overlay !== "settings") return null;
  const close = () => setOverlay(null);

  const pick = (s: ScanStrategy) => {
    setStrategy(s);
    setDefaultStrategy(s);
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,.66)] backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className="be-in flex w-[460px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line bg-bar px-4 py-3">
          <span className="text-[14px] font-semibold">Settings</span>
          <button type="button" onClick={close} className="ml-auto text-[14px] text-dim hover:text-ink">
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-5" style={{ padding: 18 }}>
          <div>
            <div className="mb-2 text-[9.5px] tracking-[0.14em] text-label">DEFAULT SCAN STRATEGY</div>
            <div className="grid grid-cols-2 gap-2">
              {STRATEGIES.map((s) => {
                const on = strategy === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pick(s.id)}
                    className="rounded-[8px] border px-3 py-2.5 text-left"
                    style={{
                      borderColor: on ? "var(--color-primary)" : "var(--color-line-modal)",
                      background: on ? "rgba(61,220,132,.14)" : "transparent",
                    }}
                  >
                    <div className="text-12" style={{ color: on ? "#7fe0a6" : "var(--color-muted)" }}>
                      {on ? "⦿ " : "◯ "}
                      {s.title}
                    </div>
                    <div className="mt-0.5 text-10 text-dim">{s.note}</div>
                  </button>
                );
              })}
            </div>
            <div className="mt-1.5 text-10 text-dim">New scans start on this; you can still switch per scan.</div>
          </div>

          <div>
            <div className="mb-2 text-[9.5px] tracking-[0.14em] text-label">APPEARANCE</div>
            <div className="rounded-[8px] border border-line bg-inset px-3 py-2.5 text-12 text-muted">
              Dark theme <span className="text-dim">· more themes later</span>
            </div>
          </div>

          <div className="flex items-center justify-between border-t border-line-soft pt-3.5 text-12 text-dim">
            <span>Keyboard shortcuts</span>
            <button
              type="button"
              onClick={() => setOverlay("shortcuts")}
              className="rounded-[6px] border border-line-input px-2.5 py-1 text-11 text-muted hover:text-ink"
            >
              View · ?
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
