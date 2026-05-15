import type React from "react";
import { Database, FolderOpen, Pause, Play, Search, Settings, Square, Trash2 } from "lucide-react";
import { formatBytes, formatCount, type ScanState } from "../domain";
import { getProgress } from "../utils/displayUtils";
import type { NativeIndexEntry } from "../nativeClient";
import logoUrl from "../assets/birds-eye-logo.svg";

interface LandingPageProps {
  scan: ScanState;
  runtimeMessage: string;
  nativeRuntime: boolean;
  savedIndexes: NativeIndexEntry[];
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  openFolderPicker: () => void;
  handleFiles: (fileList: FileList | null) => void;
  pauseScan: () => void;
  resumeScan: () => void;
  cancelScan: () => void;
  clearScan: () => void;
}

export function LandingPage({
  scan,
  runtimeMessage,
  nativeRuntime,
  savedIndexes,
  fileInputRef,
  openFolderPicker,
  handleFiles,
  pauseScan,
  resumeScan,
  cancelScan,
  clearScan,
}: LandingPageProps) {
  return (
    <section className="landing-page" id="dashboard" aria-label="Birds Eye launch interface">
      <div className="landing-outline-text" aria-hidden="true">Storage Field Index</div>
      <header className="landing-header">
        <div className="landing-brand">
          <img src={logoUrl} alt="" />
          <div>
            <strong>Birds Eye</strong>
            <span>Storage observatory / local-first</span>
          </div>
        </div>
        <div className="system-status" aria-label="System status">
          <span>Native index <b>{nativeRuntime ? "online" : "browser"}</b></span>
          <span>Engine <b>{scan.status === "idle" ? "ready" : scan.status}</b></span>
        </div>
      </header>

      <div className="landing-visual-row">
        <ProceduralStorageField />
        <ScanQueuePanel scan={scan} runtimeMessage={runtimeMessage} savedIndexes={savedIndexes} />
      </div>

      <div className="landing-content">
        <div className="landing-copy">
          <p className="eyebrow">Launch interface / scan control</p>
          <h1>
            Scan The <span>Great Expanse</span>
          </h1>
          <p className="landing-summary">
            Start local scans, monitor progress, and enter the workspace once storage terrain,
            duplicate candidates, and search indexes are ready.
          </p>
          <div className="landing-actions">
            <input
              ref={fileInputRef}
              className="hidden-input"
              type="file"
              multiple
              onChange={(event) => handleFiles(event.currentTarget.files)}
            />
            <button className="primary-action tactical-action" type="button" onClick={openFolderPicker}>
              <FolderOpen size={18} /> Start Local Scan
            </button>
            <a className="outline-action" href="#library">
              <Database size={17} /> Open Library
            </a>
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
        </div>

        <aside className="launch-details" aria-label="Scan source and configuration">
          <div className="detail-line active">
            <span>Available source</span>
            <strong>Local Directory</strong>
          </div>
          <div className="detail-line inactive">
            <span>Coming soon</span>
            <strong>S3 / Network / Multi-Directory</strong>
          </div>
          <div className="detail-line">
            <span>Default strategy</span>
            <strong>Partial FNV-1a / first + last 64 KiB / full-file verify</strong>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ProceduralStorageField() {
  return (
    <div className="storage-field" aria-hidden="true">
      <div className="field-band" />
      <div className="mass m1" />
      <div className="mass m2" />
      <div className="mass m3" />
      <div className="mass m4" />
      <div className="mass m5" />
      <svg className="field-vectors" viewBox="0 0 900 240" focusable="false">
        <path d="M74 108 C182 38, 246 186, 372 92 S600 130, 780 58" />
        <path d="M96 150 C226 208, 342 54, 502 150 S682 78, 836 168" />
        <circle cx="74" cy="108" r="5" />
        <circle cx="372" cy="92" r="5" />
        <circle cx="780" cy="58" r="5" />
        <circle cx="502" cy="150" r="5" />
      </svg>
      <span className="field-tag">Procedural storage field</span>
      <span className="field-readout">folders / density / duplicate vectors</span>
    </div>
  );
}

function ScanQueuePanel({
  scan,
  runtimeMessage,
  savedIndexes,
}: {
  scan: ScanState;
  runtimeMessage: string;
  savedIndexes: NativeIndexEntry[];
}) {
  const progress = getProgress(scan);
  const activeLabel = scan.status === "idle" ? "Awaiting source" : scan.status;
  const activeDetail = scan.status === "idle" ? runtimeMessage : scan.currentPath;

  return (
    <aside className="scan-queue-panel" id="scan-queue" aria-label="Scan queue">
      <div className="queue-header">
        <h2>Scan Queue</h2>
        <span>{scan.status === "idle" ? "Ready" : `${Math.round(progress)}%`}</span>
      </div>
      <QueueRow
        name={scan.rootName}
        detail={activeDetail}
        state={activeLabel}
        progress={scan.status === "idle" ? 0 : progress}
        tone={scan.status === "paused" ? "accent" : "primary"}
      />
      <QueueRow
        name="Multi-scan queue"
        detail="Sequential scan queue is coming soon"
        state="Coming soon"
        progress={0}
        tone="muted"
      />
      <QueueRow
        name="Library index cache"
        detail={`${formatCount(savedIndexes.length)} saved local indexes`}
        state={savedIndexes.length > 0 ? "Available" : "Empty"}
        progress={savedIndexes.length > 0 ? 100 : 0}
        tone="muted"
      />
    </aside>
  );
}

function QueueRow({
  name,
  detail,
  state,
  progress,
  tone,
}: {
  name: string;
  detail: string;
  state: string;
  progress: number;
  tone: "primary" | "accent" | "muted";
}) {
  return (
    <div className={`queue-row ${tone}`}>
      <div>
        <strong>{name}</strong>
        <span>{detail}</span>
      </div>
      <small>{state}</small>
      <div className="queue-track">
        <div style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
      </div>
    </div>
  );
}

export function BottomCommandRail({ openFolderPicker }: { openFolderPicker: () => void }) {
  return (
    <nav className="bottom-command-rail" aria-label="Primary commands">
      <button className="active" type="button" onClick={openFolderPicker}>
        <FolderOpen size={16} /> New Scan
      </button>
      <a href="#scan-queue">
        <Square size={14} /> Queue
      </a>
      <a href="#search">
        <Search size={15} /> Search
      </a>
      <a href="#library">
        <Database size={15} /> Library
      </a>
      <button className="disabled" type="button" disabled title="Settings polish is coming soon">
        <Settings size={15} /> Settings
      </button>
    </nav>
  );
}

export function StorageReadout({ scan }: { scan: ScanState }) {
  return (
    <div className="storage-readout" aria-label="Current scan readout">
      <span>{formatCount(scan.processedFiles)} files</span>
      <span>{formatBytes(scan.processedBytes)} scanned</span>
      <span>{scan.folders.length} folders</span>
    </div>
  );
}
