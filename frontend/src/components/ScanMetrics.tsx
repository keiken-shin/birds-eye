import { formatBytes, formatCount } from "../domain";
import { formatThroughput } from "../utils/displayUtils";

interface ScanMetricsProps {
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  foldersCount: number;
  elapsedMs: number;
}

export function ScanMetrics({ processedFiles, totalFiles, processedBytes, foldersCount, elapsedMs }: ScanMetricsProps) {
  const throughput = formatThroughput(processedFiles, processedBytes, elapsedMs);

  return (
    <div className="grid gap-3.5 px-3.5 py-3.5">
      <div className="grid grid-cols-3 gap-2.5">
        <MetricCard label="Files Indexed" value={`${formatCount(processedFiles)}${totalFiles > 0 ? ` / ${formatCount(totalFiles)}` : ""}`} />
        <MetricCard label="Scanned Size" value={processedBytes > 0 ? formatBytes(processedBytes) : "—"} />
        <MetricCard label="Folders" value={foldersCount > 0 ? formatCount(foldersCount) : "—"} />
      </div>
      <div className="border border-white/8 px-[12px] py-2.5">
        <span className="font-mono text-10 uppercase tracking-[1.5px] text-white/25 block mb-[4px]">Throughput</span>
        <span className="font-mono text-12 text-primary/70">{throughput}</span>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/8 px-2.5 py-[8px]">
      <span className="font-mono text-9 uppercase tracking-[1.5px] text-white/25 block mb-[4px]">{label}</span>
      <span className="font-mono text-12 font-black text-primary">{value}</span>
    </div>
  );
}



