import { formatBytes } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";

export function CleanupTray() {
  const { staged, toggleStaged, openReview } = useWorkspace();
  const total = staged.reduce((s, item) => s + item.bytes, 0);

  return (
    <div className="flex h-[60px] flex-none items-center gap-2.5 border-t border-line bg-bar px-3.5">
      <span className="flex-none text-11 tracking-[0.1em] text-label">CLEANUP TRAY</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {staged.length ? (
          staged.map((item) => (
            <span
              key={item.path}
              className="flex flex-none items-center gap-1.5 rounded-[7px] border border-primary/30 bg-primary/[0.1] px-2.5 py-1.5 text-[11.5px] text-primary-bright"
              title={item.path}
            >
              {item.name} <span className="mono text-primary-ink">{formatBytes(item.bytes)}</span>
              <button
                type="button"
                onClick={() => toggleStaged(item)}
                className="text-[13px] leading-none text-dim hover:text-ink"
              >
                ×
              </button>
            </span>
          ))
        ) : (
          <span className="text-12 italic text-label">
            Nothing staged — select something and add it here.
          </span>
        )}
      </div>
      <span className="mono flex-none text-13 text-primary-ink">{formatBytes(total)}</span>
      <button
        type="button"
        disabled={!staged.length}
        onClick={openReview}
        className="flex-none rounded-[8px] px-3.5 py-2 text-[12.5px] font-semibold"
        style={
          staged.length
            ? { background: "var(--color-primary)", color: "var(--color-on-primary)" }
            : { background: "#191c22", color: "#5b616a", cursor: "not-allowed" }
        }
      >
        Review &amp; clean →
      </button>
    </div>
  );
}
