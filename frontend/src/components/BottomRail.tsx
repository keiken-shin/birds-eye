import { NavLink } from "react-router-dom";
import { Settings } from "lucide-react";
import { QueuePopover } from "./QueuePopover";
import { SettingsPopover } from "./SettingsPopover";
import { useScanContext } from "../context/ScanContext";

const itemBase =
  "inline-flex min-h-[52px] min-w-[106px] items-center justify-center gap-1.5 border-r border-white/15 px-3 font-mono text-[11px] font-black uppercase text-[#9a9a94] no-underline last:border-r-0";
const activeClass = "text-[#00d0c4] border-b border-b-[#00d0c4]";

export function BottomRail() {
  const { queueItems } = useScanContext();
  const hasActiveScans = queueItems.some((item) => item.status === "scanning");

  return (
    <nav
      className="fixed bottom-7 left-1/2 z-20 flex max-w-[calc(100vw-28px)] -translate-x-1/2 border border-[#f4f1ea]/30 bg-[#07090d] shadow-[0_18px_70px_rgba(0,0,0,0.58)] before:pointer-events-none before:absolute before:-left-[7px] before:-top-[7px] before:h-4 before:w-4 before:border-l-2 before:border-t-2 before:border-[#f4f1ea] after:pointer-events-none after:absolute after:-bottom-[7px] after:-right-[7px] after:h-4 after:w-4 after:border-b-2 after:border-r-2 after:border-[#f4f1ea] max-sm:sticky max-sm:bottom-3 max-sm:left-2 max-sm:right-2 max-sm:mx-2 max-sm:mb-3 max-sm:overflow-x-auto max-sm:translate-x-0"
      aria-label="Primary navigation"
    >
      <NavLink
        to="/"
        end
        className={({ isActive }) => `${itemBase}${isActive ? ` ${activeClass}` : ""}`}
      >
        Home
      </NavLink>
      <NavLink
        to="/workspace"
        className={({ isActive }) => `${itemBase}${isActive ? ` ${activeClass}` : ""}`}
      >
        Workspace
      </NavLink>
      <NavLink
        to="/library"
        className={({ isActive }) => `${itemBase}${isActive ? ` ${activeClass}` : ""}`}
      >
        Library
      </NavLink>
      <QueuePopover>
        <button className={`${itemBase} relative`} type="button">
          Queue ▾
          {hasActiveScans && (
            <span className="absolute right-2 top-2 h-1.5 w-1.5 animate-pulse rounded-full bg-[#00d0c4]" />
          )}
        </button>
      </QueuePopover>
      <SettingsPopover>
        <button className={itemBase} type="button">
          <Settings size={15} /> Settings
        </button>
      </SettingsPopover>
    </nav>
  );
}
