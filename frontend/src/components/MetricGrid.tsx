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
    <section className="metric-grid" aria-label="Scan metrics">
      {metrics.map((metric) => (
        <motion.article
          className="metric-card"
          key={metric.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          <small>{metric.detail}</small>
        </motion.article>
      ))}
    </section>
  );
}
