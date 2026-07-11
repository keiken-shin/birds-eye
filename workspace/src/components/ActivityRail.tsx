import {
  ArchiveRestore,
  Layers,
  ScanLine,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { MOD } from "../lib/keys";
import { useWorkspace } from "../state/workspaceStore";
import { useScanController } from "../state/scanController";

/**
 * The system dock: scanning is the front door to everything, so it gets the
 * prominent tile; below it live the scan/queue manager, Library and Settings.
 * Icon-only — labels appear on hover. Stage views moved to the top-bar switcher.
 */
export function ActivityRail() {
  const { view, setView, setOverlay } = useWorkspace();
  const { view: jobView, queue } = useScanController();
  const running = jobView.status === "scanning";

  return (
    <nav className="flex w-12 flex-none flex-col items-center gap-1 overflow-y-auto border-r border-line bg-panel pt-2.5 pb-2.5 [scrollbar-width:none]">
      {/* New scan — the primary verb of the app. */}
      <DockButton
        icon={ScanLine}
        label={`New scan (${MOD}N)`}
        prominent
        onClick={() => setOverlay("scan")}
      />

      {/* Scans & queue — a full stage section, not a modal. */}
      <DockButton
        icon={Layers}
        label="Scans & queue"
        active={view === "scans"}
        badge={queue.length > 0 ? String(queue.length) : undefined}
        pulse={running}
        onClick={() => setView("scans")}
      />

      <div className="mt-auto flex flex-col items-center gap-1">
        <div className="mb-1 h-px w-6 bg-line" />
        <DockButton
          icon={ArchiveRestore}
          label={`Recently cleaned (${MOD}L)`}
          onClick={() => setOverlay("library")}
        />
        <DockButton
          icon={Settings}
          label={`Settings (${MOD},)`}
          onClick={() => setOverlay("settings")}
        />
      </div>
    </nav>
  );
}

function DockButton({
  icon: Icon,
  label,
  onClick,
  active = false,
  prominent = false,
  pulse = false,
  badge,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  prominent?: boolean;
  pulse?: boolean;
  badge?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`group relative flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors ${
        prominent
          ? "bg-primary text-on-primary hover:brightness-110"
          : active
            ? "border border-primary-edge bg-primary-dim text-primary"
            : "text-faint hover:bg-inset hover:text-ink"
      }`}
    >
      <Icon size={16} strokeWidth={prominent || active ? 2.1 : 1.8} aria-hidden />
      {pulse ? (
        <span
          aria-hidden
          className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-primary"
          style={{ animation: "bePulse 1.6s ease infinite" }}
        />
      ) : null}
      {badge ? (
        <span className="mono absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[8px] font-bold text-on-primary">
          {badge}
        </span>
      ) : null}
      {/* Hover label */}
      <span
        role="presentation"
        className="pointer-events-none absolute left-full z-30 ml-2 hidden rounded-md border border-line-modal bg-overlay px-2 py-1 text-10 whitespace-nowrap text-ink-soft shadow-[0_8px_30px_rgba(0,0,0,0.5)] group-hover:block"
      >
        {label}
      </span>
    </button>
  );
}
