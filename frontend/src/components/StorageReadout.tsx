import { ScanState } from "../domain";

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