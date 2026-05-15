import { motion } from "framer-motion";
import { formatBytes, formatCount } from "../domain";
import type { ScanState } from "../domain";

interface MetricGridProps {
  scan: ScanState;
}

export function MetricGrid({ scan }: MetricGridProps) {
  const metrics = [
    { label: "Indexed", value: formatCount(scan.processedFiles), detail: `${formatCount(scan.totalFiles)} selected` },
    { label: "Scanned", value: formatBytes(scan.processedBytes), detail: `${formatBytes(scan.totalBytes)} discovered` },
    { label: "Throughput", value: `${Math.round(scan.processedFiles / Math.max(scan.elapsedMs / 1000, 1))}/s`, detail: scan.status },
    { label: "Folders", value: formatCount(scan.folders.length), detail: scan.rootName },
  ];

  return (
    <section className="mb-[18px] grid grid-cols-4 gap-3.5 max-[1080px]:grid-cols-1" aria-label="Scan metrics">
      {metrics.map((metric) => (
        <motion.article
          className="relative grid min-h-28 gap-2 border border-white/15 bg-[radial-gradient(circle,rgba(244,241,234,0.09)_1px,transparent_1.2px)] bg-[length:18px_18px] p-[18px] shadow-[0_18px_60px_rgba(0,0,0,0.28)] before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-[18px] before:w-[18px] before:border-l-2 before:border-t-2 before:border-[#f4f1ea]/55"
          key={metric.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span className="font-mono text-[11px] uppercase text-[#9a9a94]">{metric.label}</span>
          <strong className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-3xl font-black text-[#f4f1ea]">{metric.value}</strong>
          <small className="font-mono text-[11px] uppercase text-[#9a9a94]">{metric.detail}</small>
        </motion.article>
      ))}
    </section>
  );
}
