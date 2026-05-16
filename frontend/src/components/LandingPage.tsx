import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Database, FolderOpen, Settings2 } from "lucide-react";
import type { ScanState } from "../domain";
import { useScanContext } from "../context/ScanContext";
import { ConfigDropdown } from "./ConfigDropdown";
import logoUrl from "../assets/birds-eye-logo.svg";

interface LandingPageProps {
  scan: ScanState;
  nativeRuntime: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  openFolderPicker: () => void;
  handleFiles: (fileList: FileList | null) => void;
}

const mono = "font-mono text-[11px] uppercase";
const primaryButton =
  "inline-flex min-h-[54px] items-center justify-center gap-2 bg-[#f4f1ea] px-6 text-sm font-black uppercase text-[#050607]";
const outlineButton =
  "inline-flex min-h-[54px] items-center justify-center gap-2 border border-[#f4f1ea]/50 px-5 text-sm font-black uppercase text-[#f4f1ea] no-underline";
const iconButton =
  "grid h-[54px] w-[54px] place-items-center border border-white/15 bg-black/25 text-[#f4f1ea] hover:bg-white/10";

export function LandingPage({
  scan,
  nativeRuntime,
  fileInputRef,
  openFolderPicker,
  handleFiles,
}: LandingPageProps) {
  const { activeQueueId } = useScanContext();
  const navigate = useNavigate();

  function handleStartScan() {
    openFolderPicker();
  }

  // Navigate to scan page once a new queue item is created
  React.useEffect(() => {
    if (activeQueueId) {
      navigate(`/scan/${activeQueueId}`);
    }
  }, [activeQueueId, navigate]);

  return (
    <section
      className="relative z-[1] mx-auto grid min-h-screen max-w-[1480px] grid-rows-[auto_minmax(176px,224px)_auto] gap-7 px-[42px] pb-32 pt-7 max-[1080px]:grid-rows-[auto_auto_auto] max-sm:min-h-svh max-sm:gap-5 max-sm:px-4 max-sm:pb-28 max-sm:pt-6"
      id="dashboard"
      aria-label="Birds Eye launch interface"
    >
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

      <div className="relative z-[1]">
        <ProceduralStorageField />
      </div>

      <div className="relative z-[1]">
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
          <button className={primaryButton} type="button" onClick={handleStartScan}>
            <FolderOpen size={18} /> Start Scan
          </button>
          <Link to="/library" className={outlineButton}>
            <Database size={17} /> Open Library
          </Link>
          <ConfigDropdown>
            <button className={`${iconButton} cursor-pointer`} type="button" aria-label="Scan configuration">
              <Settings2 size={18} />
            </button>
          </ConfigDropdown>
        </div>
      </div>
    </section>
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
      <span className="absolute bottom-4 left-[18px] bg-[#f4f1ea] px-2 py-1.5 font-mono text-[11px] uppercase font-extrabold text-[#050607] max-sm:bottom-3 max-sm:left-3 max-sm:max-w-[calc(100%-24px)]">
        Procedural storage field
      </span>
      <span className="font-mono text-[11px] uppercase absolute bottom-4 right-[18px] text-[#9a9a94] max-sm:hidden">folders / density / duplicate vectors</span>
    </div>
  );
}

export function StorageReadout({ scan }: { scan: ScanState }) {
  const mono = "font-mono text-[11px] uppercase";
  return (
    <div className="mb-3.5 flex flex-wrap gap-2.5" aria-label="Current scan readout">
      <span className={`${mono} border border-white/15 px-2.5 py-2 text-[#9a9a94]`}>{scan.processedFiles.toLocaleString()} files</span>
      <span className={`${mono} border border-white/15 px-2.5 py-2 text-[#9a9a94]`}>{scan.processedBytes > 0 ? `${(scan.processedBytes / 1073741824).toFixed(2)} GB` : "0 B"} scanned</span>
      <span className={`${mono} border border-white/15 px-2.5 py-2 text-[#9a9a94]`}>{scan.folders.length} folders</span>
    </div>
  );
}
