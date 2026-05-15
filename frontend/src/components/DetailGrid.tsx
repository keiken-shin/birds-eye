import { formatBytes, formatCount } from "../domain";
import { ScrollableRows } from "./ScrollableRows";
import type { ScanState } from "../domain";

interface DetailGridProps {
  largestFiles: ScanState["largestFiles"];
  extensions: ScanState["extensions"];
}

export function DetailGrid({ largestFiles, extensions }: DetailGridProps) {
  return (
    <section className="detail-grid">
      <div className="folder-table">
        <div className="panel-header">
          <h2>Largest Files</h2>
          <span>{formatCount(largestFiles.length)} tracked</span>
        </div>
        {largestFiles.length === 0 ? (
          <div className="empty-state compact">Largest files appear during the next scan.</div>
        ) : (
          <ScrollableRows compact>
            {largestFiles.map((file) => (
              <div className="folder-row file-row" key={file.path}>
                <span>{file.path}</span>
                <strong>{formatBytes(file.bytes)}</strong>
                <small>{file.extension}</small>
              </div>
            ))}
          </ScrollableRows>
        )}
      </div>

      <div className="folder-table">
        <div className="panel-header">
          <h2>Extensions</h2>
          <span>{formatCount(extensions.length)} groups</span>
        </div>
        {extensions.length === 0 ? (
          <div className="empty-state compact">Extension totals appear during the next scan.</div>
        ) : (
          <ScrollableRows compact>
            {extensions.map((extension) => (
              <div className="folder-row extension-row" key={extension.extension}>
                <span>.{extension.extension}</span>
                <strong>{formatBytes(extension.bytes)}</strong>
                <small>{formatCount(extension.files)} files</small>
              </div>
            ))}
          </ScrollableRows>
        )}
      </div>
    </section>
  );
}
