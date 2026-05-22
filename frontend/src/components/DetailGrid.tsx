import { FolderOpen } from "lucide-react";
import { formatBytes, formatCount } from "../domain";
import { revealInExplorer } from "../nativeClient";
import {
  ResizablePanel,
  ResizablePanelGroup,
  ResizablePanelHandle,
} from "./ResizablePanel";
import { ScrollableRows } from "./ScrollableRows";
import type { ScanState } from "../domain";

interface DetailGridProps {
  largestFiles: ScanState["largestFiles"];
  extensions: ScanState["extensions"];
  nativeRuntime: boolean;
}

export function DetailGrid({ largestFiles, extensions, nativeRuntime }: DetailGridProps) {
  const initialLargestWidth = Math.max(360, Math.round((globalThis.window?.innerWidth ?? 1440) * 0.7));

  return (
    <ResizablePanelGroup id="detail-grid-v2" className="mt-5 gap-4.5 max-[1080px]:flex-col">
      <ResizablePanel id="largest-files" defaultSize={initialLargestWidth} minSize={360}>
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
                <div className="flex items-center justify-end gap-2 max-sm:justify-start">
                  <small className={smallClass}>{file.extension}</small>
                  {nativeRuntime && (
                    <button
                      type="button"
                      aria-label={`Reveal ${file.name} in Explorer`}
                      title="Reveal in Explorer"
                      onClick={() => void revealInExplorer(file.path).catch(() => {})}
                      className="cursor-pointer grid h-8 w-8 shrink-0 place-items-center border border-white/10 text-muted transition-colors hover:border-white/25 hover:text-primary"
                    >
                      <FolderOpen size={16} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </ScrollableRows>
        )}
        </div>
      </ResizablePanel>

      <ResizablePanelHandle leftPanelId="largest-files" className="max-[1080px]:hidden" />

      <ResizablePanel id="extensions" flex>
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
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

const panelClass = "relative min-w-0 border border-white/15 bg-white/[0.045] p-5 shadow-overlay before:pointer-events-none before:absolute before:-left-px before:-top-px before:h-4.5 before:w-4.5 before:border-l-2 before:border-t-2 before:border-primary/55";
const panelHeaderClass = "mb-4 flex items-baseline justify-between gap-4 uppercase";
const panelTitleClass = "text-17 font-black uppercase text-primary";
const panelMetaClass = "inline-flex items-center gap-1.5 font-mono text-11 uppercase text-muted";
const compactEmptyClass = "grid min-h-[150px] place-items-center border border-dashed border-primary/20 bg-[radial-gradient(circle,rgba(244,241,234,0.08)_1px,transparent_1.2px)] bg-[length:18px_18px] p-6 text-center text-muted";
const fileRowClass = "grid min-h-12 grid-cols-[minmax(0,1fr)_110px_96px] items-center gap-3 border-t border-primary/10 max-sm:grid-cols-1 max-sm:gap-1 max-sm:py-2.5";
const pathClass = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-subtle";
const valueClass = "text-right text-primary max-sm:text-left";
const smallClass = "min-w-0 text-right font-mono text-muted max-sm:text-left";




