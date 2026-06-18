import { useWorkspace } from "../state/workspaceStore";

const SHORTCUTS: Array<[string, string]> = [
  ["New scan", "⌘N"],
  ["Treemap · Board · Results", "1 · 2 · 3"],
  ["Stage selection", "⇧↵"],
  ["Review & clean", "⌘↵"],
  ["Undo last clean", "⌘Z"],
  ["Settings", "⌘,"],
  ["Shortcuts", "?"],
  ["Close overlay", "Esc"],
];

export function MiscOverlay() {
  const { overlay, setOverlay } = useWorkspace();
  if (overlay !== "settings" && overlay !== "shortcuts" && overlay !== "library") return null;

  const close = () => setOverlay(null);
  const title =
    overlay === "shortcuts" ? "Keyboard shortcuts" : overlay === "settings" ? "Settings" : "Library";

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
          <span className="text-[14px] font-semibold">{title}</span>
          <button type="button" onClick={close} className="ml-auto text-[14px] text-dim hover:text-ink">
            ✕
          </button>
        </div>
        <div className="p-4.5" style={{ padding: 18 }}>
          {overlay === "shortcuts" ? (
            <div className="flex flex-col gap-2.5 text-[12px] text-ink-soft">
              {SHORTCUTS.map(([label, keys]) => (
                <div key={label} className="flex justify-between">
                  <span>{label}</span>
                  <span className="mono text-ink">{keys}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-12 italic text-label">
              {title} arrives in a later milestone. The cleanup loop (scan → inspect → stage →
              quarantine → undo) is fully wired today.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
