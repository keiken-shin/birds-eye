import type React from "react";
import { Database, FolderOpen, Pause, Play, Square, Trash2 } from "lucide-react";
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

const mono = "font-mono text-[11px] uppercase";
const panel = "border border-white/15 bg-white/[0.045] shadow-[0_18px_60px_rgba(0,0,0,0.28)]";
const primaryButton = "inline-flex min-h-[54px] items-center justify-center gap-2 bg-[#f4f1ea] px-6 text-sm font-black uppercase text-[#050607]";
const outlineButton = "inline-flex min-h-[54px] items-center justify-center gap-2 border border-[#f4f1ea]/50 px-5 text-sm font-black uppercase text-[#f4f1ea] no-underline";
const iconButton = "grid h-[42px] w-[42px] place-items-center border border-white/15 bg-black/25 text-[#f4f1ea] hover:bg-white/10";

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
    <section
      className="relative z-[1] mx-auto grid min-h-screen max-w-[1480px] grid-rows-[auto_minmax(176px,224px)_auto] gap-7 overflow-hidden px-[42px] pb-32 pt-7 max-[1080px]:grid-rows-[auto_auto_auto] max-sm:min-h-svh max-sm:gap-5 max-sm:px-4 max-sm:pb-28 max-sm:pt-6"
      id="dashboard"
      aria-label="Birds Eye launch interface"
    >
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle,rgba(255,255,255,0.13)_1px,transparent_1.3px)] bg-[length:24px_24px]" />
      <div className="pointer-events-none absolute bottom-[-208px] right-[-122px] -z-10 aspect-square w-[min(32vw,460px)] rounded-full bg-[radial-gradient(circle_at_36%_34%,#f7f7f2,#989894_38%,#4c4c4c_62%,#0d0d0d_100%)] opacity-35 shadow-[0_0_0_1px_rgba(255,255,255,0.12),-35px_-28px_90px_rgba(255,255,255,0.06)] max-sm:right-[-190px] max-sm:opacity-15" />
      <div
        className="pointer-events-none absolute right-[-24px] top-[86px] max-w-[560px] text-right text-[clamp(54px,6vw,96px)] font-black uppercase leading-[0.88] text-transparent [-webkit-text-stroke:1px_rgba(244,241,234,0.085)] max-sm:right-[-28px] max-sm:top-[92px] max-sm:text-[52px]"
        aria-hidden="true"
      >
        Storage Field Index
      </div>

      <header className="relative z-[1] flex items-center justify-between gap-6 max-sm:flex-col max-sm:items-start max-sm:gap-4">
        <div className="flex items-center gap-[13px]">
          <img className="h-[42px] w-[42px]" src={logoUrl} alt="" />
          <div className="grid gap-[3px]">
            <strong className="text-xl font-black uppercase text-[#f4f1ea] max-sm:text-[19px]">Birds Eye</strong>
            <span className={`${mono} text-[#9a9a94] max-sm:max-w-[190px]`}>Storage observatory / local-first</span>
          </div>
        </div>
        <div className={`${mono} flex items-center gap-[18px] text-[#9a9a94] max-sm:grid max-sm:w-full max-sm:grid-cols-2 max-sm:gap-2`}>
          <span>
            Native index <b className="font-extrabold text-[#b7ff5c]">{nativeRuntime ? "online" : "browser"}</b>
          </span>
          <span>
            Engine <b className="font-extrabold text-[#b7ff5c]">{scan.status === "idle" ? "ready" : scan.status}</b>
          </span>
        </div>
      </header>

      <div className="relative z-[1] grid grid-cols-[minmax(0,1fr)_310px] items-start gap-5 max-[1080px]:grid-cols-1">
        <ProceduralStorageField />
        <ScanQueuePanel scan={scan} runtimeMessage={runtimeMessage} savedIndexes={savedIndexes} />
      </div>

      <div className="relative z-[1] grid grid-cols-[minmax(0,1fr)_320px] items-start gap-[30px] max-[1080px]:grid-cols-1">
        <div>
          <p className="mb-0 text-[13px] font-bold uppercase text-[#00d0c4]">Launch interface / scan control</p>
          <h1 className="mt-2.5 max-w-[900px] text-[clamp(58px,7vw,96px)] font-black uppercase leading-[0.86] text-[#f4f1ea] max-sm:text-[52px]">
            Scan The <span className="block text-transparent [-webkit-text-stroke:1px_#f4f1ea]">Great Expanse</span>
          </h1>
          <p className="mt-[22px] max-w-[650px] text-base font-bold leading-[1.62] text-[#cacac5] max-sm:text-[15px]">
            Start local scans, monitor progress, and enter the workspace once storage terrain,
            duplicate candidates, and search indexes are ready.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3 max-sm:flex-col max-sm:items-stretch">
            <input
              ref={fileInputRef}
              className="hidden"
              type="file"
              multiple
              onChange={(event) => handleFiles(event.currentTarget.files)}
            />
            <button className={primaryButton} type="button" onClick={openFolderPicker}>
              <FolderOpen size={18} /> Start Local Scan
            </button>
            <a className={outlineButton} href="#library">
              <Database size={17} /> Open Library
            </a>
            {scan.status === "scanning" && (
              <button className={iconButton} type="button" onClick={pauseScan} title="Pause scan">
                <Pause size={18} />
              </button>
            )}
            {scan.status === "paused" && (
              <button className={iconButton} type="button" onClick={resumeScan} title="Resume scan">
                <Play size={18} />
              </button>
            )}
            {(scan.status === "scanning" || scan.status === "paused") && (
              <button className={`${iconButton} text-[#ff6b6b]`} type="button" onClick={cancelScan} title="Cancel scan">
                <Square size={16} />
              </button>
            )}
            {scan.status !== "idle" && (
              <button className={iconButton} type="button" onClick={clearScan} title="Clear results">
                <Trash2 size={18} />
              </button>
            )}
          </div>
        </div>

        <aside className="mt-6 grid gap-3.5 max-[1080px]:mt-0 max-[1080px]:max-w-[680px]" aria-label="Scan source and configuration">
          <DetailLine label="Available source" value="Local Directory" active />
          <DetailLine label="Coming soon" value="S3 / Network / Multi-Directory" inactive />
          <DetailLine label="Default strategy" value="Partial FNV-1a / first + last 64 KiB / full-file verify" />
        </aside>
      </div>
    </section>
  );
}

function DetailLine({ label, value, active = false, inactive = false }: { label: string; value: string; active?: boolean; inactive?: boolean }) {
  return (
    <div className={`grid gap-2 border-l pl-[15px] ${active ? "border-[#f4f1ea]/40" : "border-white/15"} ${inactive ? "opacity-70" : ""}`}>
      <span className={`${mono} ${active ? "text-[#b7ff5c]" : "text-[#9a9a94]"}`}>{label}</span>
      <strong className="text-sm font-black uppercase leading-normal text-[#f4f1ea]">{value}</strong>
    </div>
  );
}

function ProceduralStorageField() {
  return (
    <div className="relative min-h-56 overflow-hidden border-y border-y-white/15 bg-[radial-gradient(circle,rgba(244,241,234,0.18)_1px,transparent_1.4px)] bg-[length:18px_18px] max-sm:min-h-[166px]" aria-hidden="true">
      <div className="absolute inset-x-[12%] inset-y-[26px] left-0 border border-l-0 border-white/10" />
      <div className="absolute left-[5%] top-[28%] h-[44%] w-[18%] bg-[#f4f1ea] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.42)] max-sm:left-[8%] max-sm:top-[32%] max-sm:h-[36%] max-sm:w-[24%]" />
      <div className="absolute left-[26%] top-[35%] h-[27%] w-[12%] bg-[#00d0c4]/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.42)] max-sm:left-[36%] max-sm:w-[18%]" />
      <div className="absolute left-[41%] top-[20%] h-[56%] w-[22%] border border-white/20 bg-[#202328] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.42)] max-sm:left-[58%] max-sm:w-[26%]" />
      <div className="absolute left-[66%] top-[42%] h-[24%] w-[10%] bg-[#b7ff5c]/70 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.42)] max-sm:hidden" />
      <div className="absolute left-[79%] top-[24%] h-[48%] w-[17%] border border-white/20 bg-[#0c0e12] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.42)] max-sm:hidden" />
      <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 900 240" focusable="false">
        <path d="M74 108 C182 38, 246 186, 372 92 S600 130, 780 58" fill="none" stroke="rgba(244,241,234,0.38)" strokeDasharray="5 7" strokeWidth="1.4" />
        <path d="M96 150 C226 208, 342 54, 502 150 S682 78, 836 168" fill="none" stroke="rgba(0,208,196,0.42)" strokeDasharray="3 8" strokeWidth="1.2" />
        <circle cx="74" cy="108" r="5" fill="#f4f1ea" />
        <circle cx="372" cy="92" r="5" fill="#00d0c4" />
        <circle cx="780" cy="58" r="5" fill="#b7ff5c" />
        <circle cx="502" cy="150" r="5" fill="#f4f1ea" />
      </svg>
      <span className={`absolute bottom-4 left-[18px] bg-[#f4f1ea] px-2 py-1.5 ${mono} font-extrabold text-[#050607] max-sm:bottom-3 max-sm:left-3 max-sm:max-w-[calc(100%-24px)]`}>
        Procedural storage field
      </span>
      <span className={`${mono} absolute bottom-4 right-[18px] text-[#9a9a94] max-sm:hidden`}>folders / density / duplicate vectors</span>
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
    <aside className={`${panel} grid gap-3 bg-[#050607]/80 p-3.5 max-[1080px]:max-w-[680px]`} id="scan-queue" aria-label="Scan queue">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center uppercase">
        <h2 className="text-sm font-black text-[#f4f1ea]">Scan Queue</h2>
        <span className={`${mono} text-[#b7ff5c]`}>{scan.status === "idle" ? "Ready" : `${Math.round(progress)}%`}</span>
      </div>
      <QueueRow name={scan.rootName} detail={activeDetail} state={activeLabel} progress={scan.status === "idle" ? 0 : progress} tone="primary" />
      <QueueRow name="Multi-scan queue" detail="Sequential scan queue is coming soon" state="Coming soon" progress={0} tone="muted" />
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
  const fill = tone === "accent" ? "bg-[#00d0c4]" : "bg-[#f4f1ea]";
  return (
    <div className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-white/10 pt-2.5 max-sm:grid-cols-1 ${tone === "muted" ? "opacity-75" : ""}`}>
      <div className="grid min-w-0 gap-1">
        <strong className="truncate text-[13px] font-black text-[#f4f1ea]">{name}</strong>
        <span className={`${mono} truncate text-[#9a9a94]`}>{detail}</span>
      </div>
      <small className={`${mono} text-[#9a9a94] max-sm:justify-self-start`}>{state}</small>
      <div className="col-span-full h-1.5 bg-[#16181b]">
        <div className={`h-full ${fill}`} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
      </div>
    </div>
  );
}

export function StorageReadout({ scan }: { scan: ScanState }) {
  return (
    <div className="mb-3.5 flex flex-wrap gap-2.5" aria-label="Current scan readout">
      <ReadoutItem>{formatCount(scan.processedFiles)} files</ReadoutItem>
      <ReadoutItem>{formatBytes(scan.processedBytes)} scanned</ReadoutItem>
      <ReadoutItem>{scan.folders.length} folders</ReadoutItem>
    </div>
  );
}

function ReadoutItem({ children }: { children: React.ReactNode }) {
  return <span className={`${mono} border border-white/15 px-2.5 py-2 text-[#9a9a94]`}>{children}</span>;
}
