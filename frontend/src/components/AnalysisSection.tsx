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
  return (
    <button className="min-h-[50px] border-0 border-t border-[#f4f1ea]/15 bg-transparent p-0 text-left font-mono text-xs uppercase text-[#f4f1ea] hover:bg-white/[0.055]" type="button">
      {text}
    </button>
  );
}

export function AnalysisSection({ filteredFolders, focusedFolder, setFocusedFolder, scan }: AnalysisSectionProps) {
  return (
    <section className="grid grid-cols-[minmax(0,1fr)_340px] gap-[18px] max-[1080px]:grid-cols-1" id="treemap">
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
          <div className="mb-3 flex min-h-9 items-center gap-2 border-b border-[#f4f1ea]/10 pb-2.5">
            <button
              className="grid min-h-[34px] min-w-9 cursor-pointer place-items-center border border-white/15 bg-white/5 px-2.5 text-[#f4f1ea] hover:bg-white/10"
              type="button"
              onClick={() => setFocusedFolder(parentPath(focusedFolder))}
              title="Go up one folder"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-[#9a9a94]">{focusedFolder}</span>
            <button className="grid min-h-[34px] min-w-9 cursor-pointer place-items-center border border-white/15 bg-white/5 px-2.5 text-[#f4f1ea] hover:bg-white/10" type="button" onClick={() => setFocusedFolder(null)}>Root</button>
          </div>
        )}
        {filteredFolders.length === 0 ? (
          <div className={emptyClass}>No indexed folders yet</div>
        ) : (
          <TreemapCanvas folders={filteredFolders} onSelect={(folder) => setFocusedFolder(folder.path)} />
        )}
      </div>

      <aside className={`${panelClass} grid content-start gap-2.5`}>
        <div className={`${panelHeaderClass} mb-2`}>
          <h2 className={panelTitleClass}>Cleanup Intelligence</h2>
          <span className={panelMetaClass}>Read-only</span>
        </div>
        <Recommendation text={makeDuplicateHint(scan)} />
        <Recommendation text={makeCategoryHint(scan, "installers", "installer cache")} />
        <Recommendation text={makeCategoryHint(scan, "archives", "archive payloads")} />
        <Recommendation text={makeCategoryHint(scan, "videos", "video library")} />
        <button className="min-h-[50px] cursor-not-allowed border-0 border-t border-[#f4f1ea]/15 bg-transparent p-0 text-left font-mono text-xs uppercase text-[#9a9a94] opacity-70" type="button" disabled>
          Suggested moves engine - coming soon
        </button>
      </aside>
    </section>
  );
}

const panelClass = "relative border border-white/15 bg-white/[0.045] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)] before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-[18px] before:w-[18px] before:border-l-2 before:border-t-2 before:border-[#f4f1ea]/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-[17px] font-black uppercase text-[#f4f1ea]";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-[#9a9a94]";
const emptyClass = "grid min-h-[260px] place-items-center border border-dashed border-[#f4f1ea]/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-[#9a9a94]";
