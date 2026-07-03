import { useWorkspace } from "../state/workspaceStore";
import { MOD, isMac } from "../lib/keys";

const SHORTCUTS: Array<[string, string]> = [
  ["New scan", `${MOD}N`],
  ["Command line", isMac ? "⌥⌘K" : "Ctrl+K"],
  ["Treemap · Board · Results", "1 · 2 · 3"],
  ["Up one level (treemap)", isMac ? "⌫" : "Backspace"],
  ["Stage selection", isMac ? "⇧↵" : "Shift+Enter"],
  ["Review & clean", isMac ? "⌘↵" : "Ctrl+Enter"],
  ["Undo last clean", `${MOD}Z`],
  ["Settings", `${MOD},`],
  ["Shortcuts", "?"],
  ["Close overlay", "Esc"],
];

/** Shortcuts reference. Settings, Library, and Scans each have their own overlay component now. */
export function MiscOverlay() {
  const { overlay, setOverlay } = useWorkspace();
  if (overlay !== "shortcuts") return null;

  const close = () => setOverlay(null);

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,.66)] backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className="be-in flex w-[440px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line bg-bar px-4 py-3">
          <span className="text-[14px] font-semibold">Keyboard shortcuts</span>
          <button type="button" onClick={close} className="ml-auto text-[14px] text-dim hover:text-ink">
            ✕
          </button>
        </div>
        <div className="flex flex-col gap-2.5 text-[12px] text-ink-soft" style={{ padding: 18 }}>
          {SHORTCUTS.map(([label, keys]) => (
            <div key={label} className="flex justify-between">
              <span>{label}</span>
              <span className="mono text-ink">{keys}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
