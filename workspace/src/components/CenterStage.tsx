import { useWorkspace } from "../state/workspaceStore";
import { OverviewView } from "./views/OverviewView";
import { TreemapView } from "./views/TreemapView";
import { StagedView } from "./views/StagedView";
import { FilesView } from "./views/FilesView";
import { DuplicatesView } from "./views/DuplicatesView";
import { CleanupView } from "./views/CleanupView";
import { TimelineView } from "./views/TimelineView";
import { ScansView } from "./views/ScansView";
import { CatalogView } from "./views/CatalogView";

/** The stage: exactly one view at a time; the rail is the only switcher. */
export function CenterStage() {
  const { view } = useWorkspace();
  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-window">
      {view === "overview" && <OverviewView />}
      {view === "treemap" && <TreemapView />}
      {view === "board" && <StagedView />}
      {view === "files" && <FilesView />}
      {view === "duplicates" && <DuplicatesView />}
      {view === "cleanup" && <CleanupView />}
      {view === "timeline" && <TimelineView />}
      {view === "scans" && <ScansView />}
      {view === "catalog" && <CatalogView />}
    </div>
  );
}
