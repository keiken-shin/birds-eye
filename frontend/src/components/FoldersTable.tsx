import { Search } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { ScrollableRows } from "./ScrollableRows";
import type { FolderStats } from "../domain";

interface FoldersTableProps {
  sortedFolders: FolderStats[];
}

export function FoldersTable({ sortedFolders }: FoldersTableProps) {
  return (
    <section className="folder-table" id="data">
      <div className="panel-header">
        <h2>Largest Folders</h2>
        <span><Search size={14} /> {formatCount(sortedFolders.length)} folders</span>
      </div>
      {sortedFolders.length === 0 ? (
        <div className="empty-state">Choose a folder to generate the first storage intelligence snapshot.</div>
      ) : (
        <ScrollableRows>
          {sortedFolders.map((folder) => (
            <div className="folder-row" key={folder.path}>
              <span>{folder.path}</span>
              <strong>{formatBytes(folder.bytes)}</strong>
              <small>{formatCount(folder.files)} files</small>
            </div>
          ))}
        </ScrollableRows>
      )}
    </section>
  );
}
