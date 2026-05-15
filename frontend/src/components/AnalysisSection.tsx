import { ChevronLeft } from "lucide-react";
import { TreemapCanvas } from "./TreemapCanvas";
import { makeDuplicateHint, makeCategoryHint } from "../utils/displayUtils";
import { parentPath } from "../utils/pathUtils";
import { lastSegment } from "../domain";
import type { FolderStats, ScanState } from "../domain";

interface AnalysisSectionProps {
  filteredFolders: Array<FolderStats & { displayBytes: number }>;
  focusedFolder: string | null;
  setFocusedFolder: (folder: string | null) => void;
  scan: ScanState;
}

function Recommendation({ text }: { text: string }) {
  return <button type="button">{text}</button>;
}

export function AnalysisSection({ filteredFolders, focusedFolder, setFocusedFolder, scan }: AnalysisSectionProps) {
  return (
    <section className="analysis-layout" id="treemap">
      <div className="treemap-panel">
        <div className="panel-header">
          <h2>Space Distribution</h2>
          <span>
            {focusedFolder
              ? lastSegment(focusedFolder)
              : filteredFolders.length > 0
              ? "Largest folders by selected category"
              : "Select a folder to begin"}
          </span>
        </div>
        {focusedFolder && (
          <div className="breadcrumb-row">
            <button
              type="button"
              onClick={() => setFocusedFolder(parentPath(focusedFolder))}
              title="Go up one folder"
            >
              <ChevronLeft size={16} />
            </button>
            <span>{focusedFolder}</span>
            <button type="button" onClick={() => setFocusedFolder(null)}>Root</button>
          </div>
        )}
        {filteredFolders.length === 0 ? (
          <div className="treemap-empty">No indexed folders yet</div>
        ) : (
          <TreemapCanvas folders={filteredFolders} onSelect={(folder) => setFocusedFolder(folder.path)} />
        )}
      </div>

      <aside className="recommendations">
        <h2>Cleanup Intelligence</h2>
        <Recommendation text={makeDuplicateHint(scan)} />
        <Recommendation text={makeCategoryHint(scan, "installers", "installer cache")} />
        <Recommendation text={makeCategoryHint(scan, "archives", "archive payloads")} />
        <Recommendation text={makeCategoryHint(scan, "videos", "video library")} />
      </aside>
    </section>
  );
}
