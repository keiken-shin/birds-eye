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
    <section className="folder-table search-panel">
      <div className="panel-header">
        <h2>File Search</h2>
        <span><Search size={14} /> {formatCount(searchResults.length)} matches</span>
      </div>
      <label className="search-box">
        <Search size={16} />
        <input
          type="search"
          value={searchQuery}
          placeholder="Search indexed paths"
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
        />
      </label>
      {searchQuery.trim().length < 2 ? (
        <div className="empty-state compact">Enter at least two characters to search the current index.</div>
      ) : searchResults.length === 0 ? (
        <div className="empty-state compact">No indexed files match this search.</div>
      ) : (
        <ScrollableRows compact>
          {searchResults.map((file) => (
            <div className="folder-row file-row" key={file.path}>
              <span>{file.path}</span>
              <strong>{formatBytes(file.size)}</strong>
              <small>{file.extension ?? "(none)"}</small>
            </div>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}
