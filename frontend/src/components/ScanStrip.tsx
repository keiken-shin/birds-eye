import { getProgress } from "../utils/displayUtils";
import type { ScanState } from "../domain";

interface ScanStripProps {
  scan: ScanState;
  runtimeMessage: string;
}

export function ScanStrip({ scan, runtimeMessage }: ScanStripProps) {
  return (
    <section className="scan-strip" id="scan" aria-label="Scan progress">
      <div>
        <span>{scan.rootName}</span>
        <strong>{scan.status === "idle" ? "Ready" : scan.status}</strong>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${getProgress(scan)}%` }} />
      </div>
      <small>{runtimeMessage} - {scan.currentPath}</small>
    </section>
  );
}
