import { FolderOpen, Search } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { revealInExplorer } from "../nativeClient";
import { ScrollableRows } from "./ScrollableRows";
import type { FolderStats } from "../domain";

interface FoldersTableProps {
  sortedFolders: FolderStats[];
  nativeRuntime: boolean;
}

export function FoldersTable({ sortedFolders, nativeRuntime }: FoldersTableProps) {
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
              <div className="flex items-center justify-end gap-2 max-sm:justify-start">
                <small className={smallClass}>{formatCount(folder.files)} files</small>
                {nativeRuntime && (
                  <button
                    type="button"
                    aria-label={`Reveal ${folder.path} in Explorer`}
                    title="Reveal in Explorer"
                    onClick={() => void revealInExplorer(folder.path).catch(() => {})}
                    className="cursor-pointer grid h-8 w-8 shrink-0 place-items-center border border-white/10 text-muted transition-colors hover:border-white/25 hover:text-primary"
                  >
                    <FolderOpen size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-17 font-black uppercase text-primary";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-11 uppercase text-muted";
const emptyClass = "grid min-h-[260px] place-items-center border border-dashed border-primary/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-muted";
const rowClass = "grid min-h-12 grid-cols-[minmax(0,1fr)_120px_140px] items-center gap-3 border-t border-primary/10 max-sm:grid-cols-1 max-sm:gap-1 max-sm:py-2.5";
const pathClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-subtle";
const valueClass = "text-right text-primary max-sm:text-left";
const smallClass = "text-right font-mono text-muted max-sm:text-left";




