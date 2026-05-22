import { ChevronLeft } from "lucide-react";
import { TreemapCanvas } from "./TreemapCanvas";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizablePanelHandle,
} from "./ResizablePanel";
import { makeDuplicateHint, makeCategoryHint } from "../utils/displayUtils";
import { parentPath } from "../utils/pathUtils";
import { lastSegment } from "../domain";
import type { FolderStats, ScanState } from "../domain";

interface AnalysisSectionProps {
  filteredFolders: Array<FolderStats & { displayBytes: number }>;
  focusedFolder: string | null;
  setFocusedFolder: (folder: string | null) => void;
  onOpenDuplicateCandidate: (candidate: ScanState["duplicateCandidates"][number]) => void;
  scan: ScanState;
}

function Recommendation({ text, onClick }: { text: string; onClick?: () => void }) {
  return (
    <button
      className={`min-h-[50px] border-0 border-t border-primary/15 bg-transparent p-0 text-left font-mono text-xs uppercase ${onClick ? "text-primary hover:bg-white/[0.055]" : "cursor-default text-muted"}`}
      type="button"
      onClick={onClick}
      disabled={!onClick}
    >
      {text}
    </button>
  );
}

export function AnalysisSection({
  filteredFolders,
  focusedFolder,
  setFocusedFolder,
  onOpenDuplicateCandidate,
  scan,
}: AnalysisSectionProps) {
  const firstDuplicateCandidate = scan.duplicateCandidates.find(
    (candidate) => candidate.id !== undefined && candidate.files >= 2
  );

  return (
    <section id="treemap">
      <ResizablePanelGroup id="analysis-grid" className="gap-4.5 max-[1080px]:flex-col">
      <ResizablePanel id="space-distribution" minSize={520}>
        <div className={panelClass}>
        <div className={panelHeaderClass}>
          <h2 className={panelTitleClass}>Space Distribution</h2>
          <span className={panelMetaClass}>
            {focusedFolder
              ? lastSegment(focusedFolder)
              : filteredFolders.length > 0
              ? "Largest folders by selected category"
              : "Select a folder to begin"}
          </span>
        </div>
        {focusedFolder && (
          <div className="mb-3 flex min-h-9 items-center gap-2 border-b border-primary/10 pb-2.5">
            <button
              className="grid min-h-[34px] min-w-9 cursor-pointer place-items-center border border-white/15 bg-white/5 px-2.5 text-primary hover:bg-white/10"
              type="button"
              onClick={() => setFocusedFolder(parentPath(focusedFolder))}
              title="Go up one folder"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-13 text-muted">{focusedFolder}</span>
            <button className="grid min-h-[34px] min-w-9 cursor-pointer place-items-center border border-white/15 bg-white/5 px-2.5 text-primary hover:bg-white/10" type="button" onClick={() => setFocusedFolder(null)}>Root</button>
          </div>
        )}
        {filteredFolders.length === 0 ? (
          <div className={emptyClass}>No indexed folders yet</div>
        ) : (
          <TreemapCanvas folders={filteredFolders} onSelect={(folder) => setFocusedFolder(folder.path)} />
        )}
        </div>
      </ResizablePanel>

      <ResizablePanelHandle leftPanelId="space-distribution" className="max-[1080px]:hidden" />

      <ResizablePanel id="cleanup-intelligence" defaultSize={340} minSize={260} className="h-full">
        <aside className={`${panelClass} h-full grid content-start gap-2.5`}>
        <div className={`${panelHeaderClass} mb-2`}>
          <h2 className={panelTitleClass}>Cleanup Intelligence</h2>
          <span className={panelMetaClass}>Read-only</span>
        </div>
        <Recommendation
          text={makeDuplicateHint(scan)}
          onClick={firstDuplicateCandidate ? () => onOpenDuplicateCandidate(firstDuplicateCandidate) : undefined}
        />
        <Recommendation text={makeCategoryHint(scan, "installers", "installer cache")} />
        <Recommendation text={makeCategoryHint(scan, "archives", "archive payloads")} />
        <Recommendation text={makeCategoryHint(scan, "videos", "video library")} />
        <button className="min-h-[50px] cursor-not-allowed border-0 border-t border-primary/15 bg-transparent p-0 text-left font-mono text-xs uppercase text-muted opacity-70" type="button" disabled>
          Suggested moves engine - coming soon
        </button>
        </aside>
      </ResizablePanel>
      </ResizablePanelGroup>
    </section>
  );
}

const panelClass = "relative min-w-0 border border-white/15 bg-white/[0.045] p-5 shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-17 font-black uppercase text-primary";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-11 uppercase text-muted";
const emptyClass = "grid min-h-[260px] place-items-center border border-dashed border-primary/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-muted";




