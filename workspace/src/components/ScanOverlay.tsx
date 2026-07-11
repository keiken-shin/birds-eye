import { useEffect, useRef, useState } from "react";
import { FolderOpen, Play, Sparkles, Zap, type LucideIcon } from "lucide-react";
import {
  chooseNativeFolder,
  isNativeRuntime,
  nativeJobEvents,
  type NativePhaseTimingEntry,
} from "@bridge/nativeClient";
import { formatBytes, formatCount, type ScanStrategy } from "@bridge/domain";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { getDefaultStrategy } from "../lib/prefs";
import type { ScanJobView } from "../hooks/useScanJob";
import { OverlayShell } from "./ui/OverlayShell";
import { Button } from "./ui/Button";
import { Meter, SectionLabel, useCountUp } from "./ui/Card";
import { Tag } from "./ui/Chip";

const STRATEGIES: Array<{ id: ScanStrategy; icon: LucideIcon; title: string; note: string }> = [
  { id: "smart", icon: Sparkles, title: "Smart", note: "sizes, types and duplicate detection" },
  { id: "metadata", icon: Zap, title: "Metadata only", note: "fastest — sizes and dates" },
];

/** Log phases → text color: read activity (blue), hashing/dedup (green ramp), problems (warm). */
const PHASE_COLOR: Record<string, string> = {
  walk: "text-history",
  stat: "text-history",
  hash: "text-primary-ink",
  index: "text-primary",
  dup: "text-primary-bright",
  skip: "text-warn",
  warn: "text-warn",
  error: "text-danger",
};

export function ScanOverlay() {
  const { overlay, setOverlay } = useWorkspace();
  const { view, enqueue, cancel, reset } = useScanController();
  const [folder, setFolder] = useState("");
  const [strategy, setStrategy] = useState<ScanStrategy>(getDefaultStrategy);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [native, setNative] = useState(true);
  const [timings, setTimings] = useState<NativePhaseTimingEntry[] | null>(null);

  useEffect(() => {
    void isNativeRuntime().then(setNative);
  }, []);

  // Phase timings arrive on the terminal job event; fetch them once the scan completes.
  useEffect(() => {
    if (view.status !== "complete" || view.jobId === null) {
      setTimings(null);
      return;
    }
    let stale = false;
    void nativeJobEvents(view.jobId, 0)
      .then((events) => {
        if (stale) return;
        const withTimings = [...events].reverse().find((e) => e.phase_timings?.length);
        setTimings(withTimings?.phase_timings ?? null);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [view.status, view.jobId]);

  if (overlay !== "scan") return null;

  const progress = view.status !== "idle";
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

  const scanNow = () => {
    if (!trimmed) return;
    setError(null);
    setQueued(false);
    try {
      // Runs now if idle, otherwise joins the FIFO behind the active scan.
      if (enqueue(trimmed, strategy) === "queued") setQueued(true);
    } catch (e) {
      setError(`Couldn't start scan: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const configFooter = (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-105 text-dim">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : queued ? (
          "Added to queue — runs after the current scan."
        ) : scanning ? (
          "A scan is already running — starting another adds it to the queue."
        ) : (
          "Re-scanning an indexed folder updates it incrementally."
        )}
      </span>
      <Button variant="primary" icon={Play} disabled={!trimmed} onClick={scanNow}>
        Start scan
      </Button>
    </div>
  );

  const progressFooter = (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-105 text-dim">
        {scanning ? (
          "Runs in background — closing this window won't cancel the scan."
        ) : view.status === "failed" ? (
          <span className="text-danger">{view.message || "Scan failed."}</span>
        ) : view.status === "cancelled" ? (
          "Scan cancelled — nothing was changed."
        ) : (
          "Index ready — opened in the workspace."
        )}
      </span>
      {scanning ? (
        <Button variant="danger" onClick={() => void cancel()}>
          Cancel
        </Button>
      ) : (
        <Button
          variant="primary"
          icon={FolderOpen}
          onClick={() => {
            reset();
            close();
          }}
        >
          {view.status === "complete" ? "Open index" : "Done"}
        </Button>
      )}
    </div>
  );

  return (
    <OverlayShell
      title={progress ? "Scanning" : "New scan"}
      meta={scanning && view.pct >= 0 ? `${Math.round(view.pct)}%` : undefined}
      width={640}
      onClose={close}
      footer={progress ? progressFooter : configFooter}
    >
      {progress ? (
        <ScanProgress view={view} timings={timings} />
      ) : (
        <div className="flex flex-col gap-4 px-4.5 py-4">
          <section>
            <SectionLabel className="mb-2">Source</SectionLabel>
            <div className="flex gap-2">
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") scanNow();
                }}
                placeholder="Choose or paste a folder to scan…"
                spellCheck={false}
                className="mono min-w-0 flex-1 rounded-[9px] border border-line-input bg-field px-3 py-2.5 text-12 text-ink placeholder:text-dim focus:border-primary-edge focus:outline-none"
              />
              {native ? (
                <Button variant="ghost" icon={FolderOpen} onClick={() => void browse()}>
                  Browse
                </Button>
              ) : null}
            </div>
            {!native ? (
              <div className="mt-1.5 text-105 text-faint">
                The folder picker needs the desktop app — type or paste a folder path instead.
              </div>
            ) : null}
          </section>

          <section>
            <SectionLabel className="mb-2">Method</SectionLabel>
            <div role="radiogroup" aria-label="Scan method" className="grid grid-cols-2 gap-2">
              {STRATEGIES.map((s) => {
                const on = strategy === s.id;
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setStrategy(s.id)}
                    className={`flex flex-col gap-1 rounded-[10px] border p-3 text-left transition-colors ${
                      on
                        ? "border-primary-edge bg-primary-dim"
                        : "border-line-modal hover:border-line-strong"
                    }`}
                  >
                    <span
                      className={`flex items-center gap-1.5 text-12 font-medium ${
                        on ? "text-primary-ink" : "text-ink-soft"
                      }`}
                    >
                      <Icon size={13} strokeWidth={2} aria-hidden />
                      {s.title}
                    </span>
                    <span className="text-105 leading-relaxed text-dim">{s.note}</span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </OverlayShell>
  );
}

function ScanProgress({
  view,
  timings,
}: {
  view: ScanJobView;
  timings: NativePhaseTimingEntry[] | null;
}) {
  const running = view.status === "scanning";
  const complete = view.status === "complete";
  const logRef = useRef<HTMLDivElement>(null);

  // Follow the newest log line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.lines.length]);

  return (
    <div className="flex flex-col gap-3.5 px-4.5 py-4">
      <div className="grid grid-cols-3 gap-2.5">
        <MiniStat label="Files" live={running} value={view.files} format={(n) => formatCount(Math.round(n))} />
        <MiniStat label="Folders" live={running} value={view.folders} format={(n) => formatCount(Math.round(n))} />
        <MiniStat label="Size" live={running} value={view.bytes} format={formatBytes} />
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-115 text-muted" title={view.currentPath || undefined}>
            {view.message || "Scanning…"}
          </span>
          {view.pct >= 0 ? (
            <span className="mono flex-none text-11 text-primary-ink">{Math.round(view.pct)}%</span>
          ) : null}
        </div>
        {view.pct < 0 && running ? (
          <div style={{ animation: "bePulse 1.6s ease infinite" }}>
            <Meter fraction={1} height={8} />
          </div>
        ) : (
          <Meter fraction={complete ? 1 : Math.max(0, view.pct) / 100} height={8} />
        )}
      </div>

      <div
        ref={logRef}
        className="mono max-h-64 overflow-auto rounded-[9px] bg-field px-3 py-2.5 text-105 leading-[1.7]"
      >
        {view.lines.map((l) => (
          <div key={l.n} className="flex gap-2">
            <span className={`w-10 flex-none ${PHASE_COLOR[l.phase] ?? "text-faint"}`}>{l.phase}</span>
            <span className="min-w-0 flex-1 truncate text-ink-soft" title={l.message}>
              {l.message}
            </span>
          </div>
        ))}
        {!view.lines.length ? <div className="text-dim">Waiting for activity…</div> : null}
      </div>

      {complete && timings?.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {timings.map((t) => (
            <Tag key={t.phase} tone="green">
              {t.phase} <span className="mono">{(t.duration_ms / 1000).toFixed(1)}s</span>
            </Tag>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Live values tick raw while scanning (a from-zero count-up would restart on every
 * event); once the scan settles, the shared count-up rolls the final total in.
 */
function MiniStat({
  label,
  value,
  live,
  format,
}: {
  label: string;
  value: number;
  live: boolean;
  format: (n: number) => string;
}) {
  const animated = useCountUp(value);
  const shown = live ? value : animated;
  return (
    <div className="rounded-[10px] border border-line bg-inset px-3 py-2">
      <SectionLabel>{label}</SectionLabel>
      <div className="mono mt-1 text-15 font-semibold text-ink">{format(shown)}</div>
    </div>
  );
}
