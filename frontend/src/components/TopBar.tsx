import React from "react";
import { FolderOpen, Pause, Play, Square, Trash2 } from "lucide-react";
import type { ScanState } from "../domain";

interface TopBarProps {
  scan: ScanState;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  openFolderPicker: () => void;
  handleFiles: (fileList: FileList | null) => void;
  pauseScan: () => void;
  resumeScan: () => void;
  cancelScan: () => void;
  clearScan: () => void;
}

export function TopBar({
  scan,
  fileInputRef,
  openFolderPicker,
  handleFiles,
  pauseScan,
  resumeScan,
  cancelScan,
  clearScan,
}: TopBarProps) {
  return (
    <header className="topbar" id="dashboard">
      <div>
        <p className="eyebrow">Offline storage intelligence</p>
        <h1>Understand where your disk space went.</h1>
      </div>
      <div className="action-row">
        <input
          ref={fileInputRef}
          className="hidden-input"
          type="file"
          multiple
          onChange={(event) => handleFiles(event.currentTarget.files)}
        />
        <button className="primary-action" type="button" onClick={openFolderPicker}>
          <FolderOpen size={18} /> Choose Folder
        </button>
        {scan.status === "scanning" && (
          <button className="ghost-action" type="button" onClick={pauseScan} title="Pause scan">
            <Pause size={18} />
          </button>
        )}
        {scan.status === "paused" && (
          <button className="ghost-action" type="button" onClick={resumeScan} title="Resume scan">
            <Play size={18} />
          </button>
        )}
        {(scan.status === "scanning" || scan.status === "paused") && (
          <button className="ghost-action danger" type="button" onClick={cancelScan} title="Cancel scan">
            <Square size={16} />
          </button>
        )}
        {scan.status !== "idle" && (
          <button className="ghost-action" type="button" onClick={clearScan} title="Clear results">
            <Trash2 size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
