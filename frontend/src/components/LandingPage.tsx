import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Database, FolderOpen, Settings2 } from "lucide-react";
import type { ScanState } from "../domain";
import { useScanContext } from "../context/ScanContext";
import { ConfigDropdown } from "./ConfigDropdown";
import logoUrl from "../assets/birds-eye-logo.svg";
import { ProceduralStorageField } from "./ProceduralStorageField";

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
