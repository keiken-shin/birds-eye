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
    <section className="folder-table" id="settings">
      <div className="panel-header">
        <h2>Saved Indexes</h2>
        <span>
          <Database size={14} /> {nativeRuntime ? `${formatCount(savedIndexes.length)} local` : "Native only"}
        </span>
      </div>
      {!nativeRuntime ? (
        <div className="empty-state compact">Saved indexes are available in the desktop app.</div>
      ) : savedIndexes.length === 0 ? (
        <div className="empty-state compact">
          Scanned folders will appear here for revisiting, rescanning, or removing their local index.
        </div>
      ) : (
        <ScrollableRows compact>
          {savedIndexes.map((entry) => (
            <div className="index-row" key={entry.index_path}>
              <div>
                <strong>{entry.root_path ?? "Unknown root"}</strong>
                <span>
                  {entry.last_status ?? "unknown"} - {formatBytes(entry.bytes_scanned)} -{" "}
                  {formatCount(entry.files_scanned)} files
                </span>
              </div>
              <button type="button" onClick={() => void openSavedIndex(entry)}>View</button>
              <button type="button" onClick={() => void rescanSavedIndex(entry)}>Rescan</button>
              <button className="danger-text" type="button" onClick={() => void removeSavedIndex(entry)}>Delete</button>
            </div>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}
