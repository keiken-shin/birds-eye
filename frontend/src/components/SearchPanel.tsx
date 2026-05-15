import { Search } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { ScrollableRows } from "./ScrollableRows";
import type { NativeSearchResult } from "../nativeClient";

interface SearchPanelProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: NativeSearchResult[];
}

export function SearchPanel({ searchQuery, setSearchQuery, searchResults }: SearchPanelProps) {
  return (
    <section className={`${panelClass} grid gap-3`} id="search">
      <div className={panelHeaderClass}>
        <h2 className={panelTitleClass}>File Search</h2>
        <span className={panelMetaClass}><Search size={14} /> {formatCount(searchResults.length)} matches</span>
      </div>
      <label className="flex min-h-11 items-center gap-2.5 border border-[#f4f1ea]/20 bg-black/25 px-3 text-[#9a9a94]">
        <Search size={16} />
        <input
          className="w-full min-w-0 border-0 bg-transparent font-inherit text-[#f4f1ea] outline-0 placeholder:text-[#687386]"
          type="search"
          value={searchQuery}
          placeholder="Search indexed paths"
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
        />
      </label>
      {searchQuery.trim().length < 2 ? (
        <div className={compactEmptyClass}>Enter at least two characters to search the current index.</div>
      ) : searchResults.length === 0 ? (
        <div className={compactEmptyClass}>No indexed files match this search.</div>
      ) : (
        <ScrollableRows compact>
          {searchResults.map((file) => (
            <div className={fileRowClass} key={file.path}>
              <span className={pathClass}>{file.path}</span>
              <strong className={valueClass}>{formatBytes(file.size)}</strong>
              <small className={smallClass}>{file.extension ?? "(none)"}</small>
            </div>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)] before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-[18px] before:w-[18px] before:border-l-2 before:border-t-2 before:border-[#f4f1ea]/55";
const panelHeaderClass = "mb-1 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-[17px] font-black uppercase text-[#f4f1ea]";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-[#9a9a94]";
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-[#f4f1ea]/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-[#9a9a94]";
const fileRowClass = "grid min-h-12 grid-cols-[minmax(0,1fr)_110px_72px] items-center gap-3 border-t border-[#f4f1ea]/10 max-sm:grid-cols-1 max-sm:gap-1 max-sm:py-2.5";
const pathClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#dedbd4]";
const valueClass = "text-right text-[#f4f1ea] max-sm:text-left";
const smallClass = "text-right font-mono text-[#9a9a94] max-sm:text-left";
