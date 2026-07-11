import {
  CalendarClock,
  Copy,
  Files,
  Gauge,
  LayoutGrid,
  Network,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { StageView } from "../state/types";

export type StageViewEntry = { view: StageView; label: string; icon: LucideIcon; key: string };

/**
 * The seven analysis views shown in the top-bar switcher, in shortcut order
 * (1–7). The "scans" system view lives on the rail, not here.
 */
export const STAGE_VIEWS: StageViewEntry[] = [
  { view: "overview", label: "Overview", icon: Gauge, key: "1" },
  { view: "treemap", label: "Treemap", icon: LayoutGrid, key: "2" },
  { view: "board", label: "Board", icon: Network, key: "3" },
  { view: "files", label: "Files", icon: Files, key: "4" },
  { view: "duplicates", label: "Duplicates", icon: Copy, key: "5" },
  { view: "cleanup", label: "Cleanup", icon: Sparkles, key: "6" },
  { view: "timeline", label: "Timeline", icon: CalendarClock, key: "7" },
];
