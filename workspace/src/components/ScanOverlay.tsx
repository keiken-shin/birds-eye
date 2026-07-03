import { useEffect, useState } from "react";
import { chooseNativeFolder, isNativeRuntime } from "@bridge/nativeClient";
import { formatBytes, formatCount, type ScanStrategy } from "@bridge/domain";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { getDefaultStrategy } from "../lib/prefs";

const STRATEGIES: Array<{ id: ScanStrategy; title: string; note: string }> = [
  { id: "smart", title: "Smart (deep + dedup)", note: "full walk + content hashing to find duplicates · most accurate" },
  { id: "metadata", title: "Metadata only", note: "fast index without hashing · seconds" },
];

export function ScanOverlay() {
  const { overlay, setOverlay } = useWorkspace();
  const { view, start, cancel, reset } = useScanController();
  const [folder, setFolder] = useState("");
  const [strategy, setStrategy] = useState<ScanStrategy>(getDefaultStrategy);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [native, setNative] = useState(true);

  useEffect(() => {
    void isNativeRuntime().then(setNative);
  }, []);

  if (overlay !== "scan") return null;

  const scanning = view.status === "scanning";
  const close = () => setOverlay(null);
  const trimmed = folder.trim();

  const browse = async () => {
    setError(null);
    try {
      const picked = await chooseNativeFolder();
      if (picked) setFolder(picked);
    } catch (e) {
      setError(`Folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const scanNow = async () => {
    if (!trimmed || starting) return;
    setStarting(true);
    setError(null);
    try {
      await start(trimmed, strategy);
    } catch (e) {
      setError(`Couldn't start scan: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,7,9,.66)] backdrop-blur-[3px]"
      onClick={close}
    >
      <div
        className="be-in flex max-h-[680px] w-[640px] flex-col overflow-hidden rounded-[14px] border border-line-modal bg-overlay shadow-[0_30px_80px_-20px_rgba(0,0,0,.8)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line bg-bar px-4 py-3">
          <span className="text-[14px] font-semibold">{scanning ? "Scanning" : "New scan"}</span>
          <span className="text-11 text-dim">
            {scanning ? view.message || "in progress" : "configure a source & method"}
          </span>
          <button type="button" onClick={close} className="ml-auto text-[14px] text-dim hover:text-ink">
            ✕
          </button>
        </div>

        {view.status === "idle" ? (
          <>
            <div className="flex flex-col gap-4 p-4.5" style={{ padding: 18 }}>
              {!native && (
                <div className="rounded-[7px] border border-warn/40 bg-warn/[0.08] px-3 py-2 text-11 text-warn">
                  Folder picker & scanning run in the desktop app — launch it with{" "}
                  <span className="mono">tauri dev --config src-tauri/tauri.workspace.conf.json</span>.
                </div>
              )}
              <div>
                <div className="mb-2 text-[9.5px] tracking-[0.14em] text-label">SOURCE</div>
                <div className="rounded-[8px] border border-primary/40 bg-primary/[0.08] px-3 py-2.5">
                  <div className="text-[12.5px] text-primary-ink">▣ Local filesystem</div>
                  <div className="mono text-10 text-primary-ink opacity-70">
                    External · network · object storage — future
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[9.5px] tracking-[0.14em] text-label">PATH / SCOPE</div>
                <div className="flex gap-2">
                  <input
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder="Choose or paste a folder to scan…"
                    spellCheck={false}
                    className="mono flex-1 rounded-[7px] border border-line-input bg-field px-3 py-2.5 text-12 text-ink placeholder:text-dim focus:border-primary/60 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void browse()}
                    disabled={!native}
                    title={native ? "Pick a folder" : "The folder picker only runs in the desktop app"}
                    className="rounded-[7px] border border-line-input px-3 text-12 text-muted hover:text-ink disabled:opacity-50"
                  >
                    Browse…
                  </button>
                </div>
              </div>

              <div>
                <div className="mb-2 text-[9.5px] tracking-[0.14em] text-label">ALGORITHM</div>
                <div className="grid grid-cols-2 gap-2">
                  {STRATEGIES.map((s) => {
                    const on = strategy === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setStrategy(s.id)}
                        className="rounded-[8px] border px-3 py-2.5 text-left"
                        style={{
                          borderColor: on ? "var(--color-primary)" : "var(--color-line-modal)",
                          background: on ? "rgba(61,220,132,.14)" : "transparent",
                        }}
                      >
                        <div className="text-12" style={{ color: on ? "#7fe0a6" : "var(--color-muted)" }}>
                          {on ? "⦿" : "◯"} {s.title}
                        </div>
                        <div className="mt-0.5 text-10 text-dim">{s.note}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 border-t border-line bg-bar px-4 py-3">
              <span className="text-11 text-dim">
                {error ? <span className="text-danger">{error}</span> : "Incremental rescans run automatically on re-scan."}
              </span>
              <button
                type="button"
                disabled={!trimmed || starting}
                onClick={() => void scanNow()}
                className="ml-auto rounded-[7px] bg-primary px-4 py-2 text-12 font-semibold text-on-primary disabled:opacity-50"
              >
                {starting ? "Starting…" : "Scan now →"}
              </button>
            </div>
          </>
        ) : (
          <ScanProgress view={view} onCancel={() => void cancel()} onReset={reset} onClose={close} />
        )}
      </div>
    </div>
  );
}

function ScanProgress({
  view,
  onCancel,
  onReset,
  onClose,
}: {
  view: ReturnType<typeof useScanController>["view"];
  onCancel: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const done = view.status !== "scanning";
  return (
    <>
      <div className="flex flex-wrap items-center gap-4 border-b border-line bg-bar px-4 py-3.5">
        <div className="flex min-w-[230px] flex-1 flex-col gap-1.5">
          <div className="flex justify-between text-11 text-dim">
            <span className="truncate">{view.currentPath || view.message || "scanning…"}</span>
            <span className="text-primary-ink">{view.pct < 0 ? "" : `${Math.round(view.pct)}%`}</span>
          </div>
          <div className="h-[9px] overflow-hidden rounded-[5px] bg-[#2a2d31]">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: view.pct < 0 ? "100%" : `${view.pct}%`, opacity: view.pct < 0 ? 0.4 : 1 }}
            />
          </div>
        </div>
        <Count label="FILES" value={formatCount(view.files)} />
        <Count label="FOLDERS" value={formatCount(view.folders)} />
        <Count label="SIZE" value={formatBytes(view.bytes)} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[#15171a] p-3.5">
        <div className="mono text-[11px] leading-[1.62]">
          <div className="mb-1.5 text-dim">── live scan log ──</div>
          {view.lines.map((l) => (
            <div key={l.n}>
              <span className="text-[#6ea8fe]">{l.phase.padEnd(6)}</span>{" "}
              <span className="text-[#c5c8cc]">{l.message}</span>
            </div>
          ))}
          {!view.lines.length && <div className="text-dim">waiting for activity…</div>}
        </div>
      </div>

      <div className="flex items-center gap-2.5 border-t border-line bg-bar px-4 py-3 text-12 text-dim">
        <span>runs in background — you can keep working in any lens</span>
        {done ? (
          <>
            <span className="ml-auto text-primary-ink">
              {view.status === "complete" ? "✓ index ready" : view.status}
            </span>
            <button
              type="button"
              onClick={() => {
                onReset();
                onClose();
              }}
              className="rounded-[6px] bg-primary px-3 py-1.5 font-semibold text-on-primary"
            >
              Done
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto rounded-[6px] border border-[#5c4a2a] px-3 py-1.5 text-warn"
          >
            Cancel
          </button>
        )}
      </div>
    </>
  );
}

function Count({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[9.5px] tracking-[0.1em] text-label">{label}</div>
      <div className="mono text-[15px]">{value}</div>
    </div>
  );
}
