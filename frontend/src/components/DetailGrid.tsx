import { formatBytes, formatCount } from "../domain";
import { ScrollableRows } from "./ScrollableRows";
import type { ScanState } from "../domain";

interface DetailGridProps {
  largestFiles: ScanState["largestFiles"];
  extensions: ScanState["extensions"];
}

export function DetailGrid({ largestFiles, extensions }: DetailGridProps) {
  return (
    <section className="grid grid-cols-2 gap-[18px] max-[1080px]:grid-cols-1">
      <div className={panelClass}>
        <div className={panelHeaderClass}>
          <h2 className={panelTitleClass}>Largest Files</h2>
          <span className={panelMetaClass}>{formatCount(largestFiles.length)} tracked</span>
        </div>
        {largestFiles.length === 0 ? (
          <div className={compactEmptyClass}>Largest files appear during the next scan.</div>
        ) : (
          <ScrollableRows compact>
            {largestFiles.map((file) => (
              <div className={fileRowClass} key={file.path}>
                <span className={pathClass}>{file.path}</span>
                <strong className={valueClass}>{formatBytes(file.bytes)}</strong>
                <small className={smallClass}>{file.extension}</small>
              </div>
            ))}
          </ScrollableRows>
        )}
      </div>

      <div className={panelClass}>
        <div className={panelHeaderClass}>
          <h2 className={panelTitleClass}>Extensions</h2>
          <span className={panelMetaClass}>{formatCount(extensions.length)} groups</span>
        </div>
        {extensions.length === 0 ? (
          <div className={compactEmptyClass}>Extension totals appear during the next scan.</div>
        ) : (
          <ScrollableRows compact>
            {extensions.map((extension) => (
              <div className={fileRowClass} key={extension.extension}>
                <span className={pathClass}>.{extension.extension}</span>
                <strong className={valueClass}>{formatBytes(extension.bytes)}</strong>
                <small className={smallClass}>{formatCount(extension.files)} files</small>
              </div>
            ))}
          </ScrollableRows>
        )}
      </div>
    </section>
  );
}

const panelClass = "relative mt-5 border border-white/15 bg-white/[0.045] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.28)] before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-[18px] before:w-[18px] before:border-l-2 before:border-t-2 before:border-[#f4f1ea]/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-[17px] font-black uppercase text-[#f4f1ea]";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-[#9a9a94]";
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-[#f4f1ea]/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-[#9a9a94]";
const fileRowClass = "grid min-h-12 grid-cols-[minmax(0,1fr)_110px_72px] items-center gap-3 border-t border-[#f4f1ea]/10 max-sm:grid-cols-1 max-sm:gap-1 max-sm:py-2.5";
const pathClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[#dedbd4]";
const valueClass = "text-right text-[#f4f1ea] max-sm:text-left";
const smallClass = "text-right font-mono text-[#9a9a94] max-sm:text-left";
