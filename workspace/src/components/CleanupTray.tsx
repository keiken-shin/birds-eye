import { ArrowRight, X } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { Button } from "./ui/Button";
import { SectionLabel } from "./ui/Card";

const MAX_CHIPS = 6;

export function CleanupTray() {
  const { staged, toggleStaged, openReview } = useWorkspace();
  const total = staged.reduce((s, item) => s + item.bytes, 0);
  const shown = staged.slice(0, MAX_CHIPS);
  const overflow = staged.length - shown.length;

  return (
    <div className="flex h-[60px] flex-none items-center gap-3 border-t border-line bg-bar px-3.5">
      <SectionLabel className="flex-none">Cleanup tray</SectionLabel>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {staged.length ? (
          <>
            {shown.map((item) => (
              <span
                key={item.path}
                title={item.path}
                className="flex flex-none items-center gap-1.5 rounded-full border border-primary-edge bg-primary-dim py-1 pl-2.5 pr-1.5 text-115 text-primary-bright"
              >
                <span className="max-w-40 truncate">{item.name}</span>
                <span className="mono text-primary-ink">{formatBytes(item.bytes)}</span>
                <button
                  type="button"
                  aria-label={`Unstage ${item.name}`}
                  title={`Unstage ${item.name}`}
                  onClick={() => toggleStaged(item)}
                  className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-faint transition-colors hover:text-ink"
                >
                  <X size={11} strokeWidth={2} aria-hidden />
                </button>
              </span>
            ))}
            {overflow > 0 ? (
              <span className="flex flex-none items-center rounded-full border border-line-modal px-2.5 py-1 text-115 text-faint">
                +{overflow} more
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-12 italic text-label">
            Nothing staged — select something and add it here.
          </span>
        )}
      </div>
      <span className="mono flex-none text-13 text-primary-ink">{formatBytes(total)}</span>
      <Button
        variant="primary"
        icon={ArrowRight}
        disabled={!staged.length}
        onClick={openReview}
        className="flex-none"
      >
        Review &amp; clean
      </Button>
    </div>
  );
}
