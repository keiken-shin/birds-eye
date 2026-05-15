import { Search } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { ScrollableRows } from "./ScrollableRows";
import type { FolderStats } from "../domain";

interface FoldersTableProps {
  sortedFolders: FolderStats[];
}

export function FoldersTable({ sortedFolders }: FoldersTableProps) {
  return (
    <section className={panelClass} id="data">
      <div className={panelHeaderClass}>
        <h2 className={panelTitleClass}>Largest Folders</h2>
        <span className={panelMetaClass}><Search size={14} /> {formatCount(sortedFolders.length)} folders</span>
      </div>
      {sortedFolders.length === 0 ? (
        <div className={emptyClass}>Choose a folder to generate the first storage intelligence snapshot.</div>
      ) : (
        <ScrollableRows>
          {sortedFolders.map((folder) => (
            <div className={rowClass} key={folder.path}>
              <span className={pathClass}>{folder.path}</span>
              <strong className={valueClass}>{formatBytes(folder.bytes)}</strong>
              <small className={smallClass}>{formatCount(folder.files)} files</small>
            </div>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)] before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-[18px] before:w-[18px] before:border-l-2 before:border-t-2 before:border-[#f4f1ea]/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-[17px] font-black uppercase text-[#f4f1ea]";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-[#9a9a94]";
const emptyClass = "grid min-h-[260px] place-items-center border border-dashed border-[#f4f1ea]/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-[#9a9a94]";
const rowClass = "grid min-h-12 grid-cols-[minmax(0,1fr)_120px_100px] items-center gap-3 border-t border-[#f4f1ea]/10 max-sm:grid-cols-1 max-sm:gap-1 max-sm:py-2.5";
const pathClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#dedbd4]";
const valueClass = "text-right text-[#f4f1ea] max-sm:text-left";
const smallClass = "text-right font-mono text-[#9a9a94] max-sm:text-left";
