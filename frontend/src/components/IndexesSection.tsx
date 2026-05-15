import { Database } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { ScrollableRows } from "./ScrollableRows";
import type { NativeIndexEntry } from "../nativeClient";

interface IndexesSectionProps {
  nativeRuntime: boolean;
  savedIndexes: NativeIndexEntry[];
  openSavedIndex: (entry: NativeIndexEntry) => Promise<void>;
  rescanSavedIndex: (entry: NativeIndexEntry) => Promise<void>;
  removeSavedIndex: (entry: NativeIndexEntry) => Promise<void>;
}

export function IndexesSection({
  nativeRuntime,
  savedIndexes,
  openSavedIndex,
  rescanSavedIndex,
  removeSavedIndex,
}: IndexesSectionProps) {
  return (
    <section className={panelClass} id="library">
      <div className={panelHeaderClass}>
        <h2 className={panelTitleClass}>Saved Indexes</h2>
        <span className={panelMetaClass}>
          <Database size={14} /> {nativeRuntime ? `${formatCount(savedIndexes.length)} local` : "Native only"}
        </span>
      </div>
      {!nativeRuntime ? (
        <div className={compactEmptyClass}>Saved indexes are available in the desktop app.</div>
      ) : savedIndexes.length === 0 ? (
        <div className={compactEmptyClass}>
          Scanned folders will appear here for revisiting, rescanning, or removing their local index.
        </div>
      ) : (
        <ScrollableRows compact>
          {savedIndexes.map((entry) => (
            <div className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2.5 border-t border-[#f4f1ea]/10 max-sm:grid-cols-1 max-sm:py-2.5" key={entry.index_path}>
              <div className="grid min-w-0 gap-1">
                <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#f4f1ea]">{entry.root_path ?? "Unknown root"}</strong>
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-[#9a9a94]">
                  {entry.last_status ?? "unknown"} - {formatBytes(entry.bytes_scanned)} -{" "}
                  {formatCount(entry.files_scanned)} files
                </span>
              </div>
              <button className={indexButtonClass} type="button" onClick={() => void openSavedIndex(entry)}>View</button>
              <button className={indexButtonClass} type="button" onClick={() => void rescanSavedIndex(entry)}>Rescan</button>
              <button className={`${indexButtonClass} text-[#ff6b6b]`} type="button" onClick={() => void removeSavedIndex(entry)}>Delete</button>
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
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-[#f4f1ea]/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-[#9a9a94]";
const indexButtonClass = "min-h-[34px] cursor-pointer border border-white/15 bg-white/5 px-2.5 uppercase text-[#f4f1ea] hover:bg-white/10";
