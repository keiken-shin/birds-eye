import { ArrowRight, X } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { useIndexData } from "../state/indexData";
import { REMOTE_ACTION_HINT, capabilitiesForSource } from "../lib/sourceCapabilities";
import { Button } from "./ui/Button";
import { SectionLabel } from "./ui/Card";

const MAX_CHIPS = 6;

type Chip = {
  key: string;
  path: string;
  label: string;
  bytes: number;
  hint: string | null;
  remove: () => void;
};

/**
 * The staging bar. It holds two independent kinds — cleanups (delete-scoped)
 * and relocations (each with its own destination) — because the review gates
 * and backends behind them share nothing.
 */
export function CleanupTray() {
  const { staged, toggleStaged, openReview, stagedMoves, toggleStagedMove, openRelocateReview } =
    useWorkspace();
  const { activeEntry } = useIndexData();
  // Cleaning and moving happen on disk — a scan of another machine can't do either.
  const canAct = capabilitiesForSource(activeEntry?.source).mutate;

  const cleanBytes = staged.reduce((s, item) => s + item.bytes, 0);
  const moveBytes = stagedMoves.reduce((s, item) => s + item.bytes, 0);
  const count = staged.length + stagedMoves.length;

  const chips: Chip[] = [
    ...staged.map((item) => ({
      key: `clean:${item.path}`,
      path: item.path,
      label: item.name,
      bytes: item.bytes,
      hint: null,
      remove: () => toggleStaged(item),
    })),
    ...stagedMoves.map((item) => ({
      key: `move:${item.path}`,
      path: item.path,
      label: item.name,
      bytes: item.bytes,
      hint: item.to,
      remove: () => toggleStagedMove(item),
    })),
  ];
  const shown = chips.slice(0, MAX_CHIPS);
  const overflow = chips.length - shown.length;

  const label =
    staged.length && stagedMoves.length ? "Staged" : stagedMoves.length ? "Move tray" : "Cleanup tray";

  return (
    <div className="flex h-[60px] flex-none items-center gap-3 border-t border-line bg-bar px-3.5">
      <SectionLabel className="flex-none">{label}</SectionLabel>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {count ? (
          <>
            {shown.map((chip) => (
              <span
                key={chip.key}
                title={chip.hint ? `${chip.path} → ${chip.hint}` : chip.path}
                className="flex flex-none items-center gap-1.5 rounded-full border border-primary-edge bg-primary-dim py-1 pl-2.5 pr-1.5 text-115 text-primary-bright"
              >
                <span className="max-w-40 truncate">{chip.label}</span>
                {chip.hint ? <ArrowRight size={10} className="flex-none opacity-70" aria-hidden /> : null}
                <span className="mono text-primary-ink">{formatBytes(chip.bytes)}</span>
                <button
                  type="button"
                  aria-label={`Unstage ${chip.label}`}
                  title={`Unstage ${chip.label}`}
                  onClick={chip.remove}
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
            {canAct ? "Nothing staged — select something and add it here." : REMOTE_ACTION_HINT}
          </span>
        )}
      </div>
      <span className="mono flex-none text-13 text-primary-ink">
        {formatBytes(cleanBytes + moveBytes)}
      </span>
      {/* The tray shows the whole desk, so its button reviews the whole desk —
          hence no argument. Passed as `onClick={openReview}` it would hand the
          click event in as the path list. */}
      {staged.length ? (
        <Button
          variant="primary"
          icon={ArrowRight}
          onClick={() => openReview()}
          disabled={!canAct}
          title={canAct ? undefined : REMOTE_ACTION_HINT}
          className="flex-none"
        >
          Review &amp; clean
        </Button>
      ) : null}
      {stagedMoves.length ? (
        <Button
          variant="primary"
          icon={ArrowRight}
          onClick={openRelocateReview}
          disabled={!canAct}
          title={canAct ? undefined : REMOTE_ACTION_HINT}
          className="flex-none"
        >
          Review &amp; move
        </Button>
      ) : null}
      {count === 0 ? (
        <Button variant="primary" icon={ArrowRight} disabled className="flex-none">
          Review
        </Button>
      ) : null}
    </div>
  );
}
