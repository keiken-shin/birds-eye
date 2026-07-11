import { useWorkspace } from "../state/workspaceStore";
import { OverviewView } from "./views/OverviewView";
import { TreemapView } from "./views/TreemapView";
import { BoardView } from "./views/BoardView";
import { FilesView } from "./views/FilesView";
import { DuplicatesView } from "./views/DuplicatesView";
import { CleanupView } from "./views/CleanupView";
import { TimelineView } from "./views/TimelineView";
import { ScansView } from "./views/ScansView";

/** The stage: exactly one view at a time; the rail is the only switcher. */
export function CenterStage() {
  const { view } = useWorkspace();
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-window">
      {view === "overview" && <OverviewView />}
      {view === "treemap" && <TreemapView />}
      {view === "board" && <BoardView />}
      {view === "files" && <FilesView />}
      {view === "duplicates" && <DuplicatesView />}
      {view === "cleanup" && <CleanupView />}
      {view === "timeline" && <TimelineView />}
      {view === "scans" && <ScansView />}
    </div>
  );
}
