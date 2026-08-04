import {
  CalendarClock,
  Copy,
  Files,
  FolderTree,
  Gauge,
  LayoutGrid,
  Network,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { StageView } from "../state/types";

export type StageViewEntry = { view: StageView; label: string; icon: LucideIcon; key: string };

/**
 * The eight analysis views shown in the top-bar switcher, in shortcut order
 * (1–8). The "scans" system view lives on the rail, not here.
 *
 * `view` keys are internal and never change. `label` is what a user reads, so
 * it is plain English: "Map", not "Treemap"; "By age", not "Timeline".
 */
export const STAGE_VIEWS: StageViewEntry[] = [
  { view: "overview", label: "Overview", icon: Gauge, key: "1" },
  { view: "treemap", label: "Map", icon: LayoutGrid, key: "2" },
  { view: "board", label: "Findings", icon: Network, key: "3" },
  { view: "files", label: "Files", icon: Files, key: "4" },
  { view: "duplicates", label: "Duplicates", icon: Copy, key: "5" },
  { view: "cleanup", label: "Clean up", icon: Sparkles, key: "6" },
  { view: "timeline", label: "By age", icon: CalendarClock, key: "7" },
  { view: "catalog", label: "Organise", icon: FolderTree, key: "8" },
];
