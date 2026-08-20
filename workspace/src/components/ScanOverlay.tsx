import { useEffect, useRef, useState } from "react";
import { FolderOpen, HardDrive, Info, Play, Server, Sparkles, Zap, type LucideIcon } from "lucide-react";
import {
  chooseNativeFolder,
  isNativeRuntime,
  listFixedDrives,
  nativeJobEvents,
  type NativeDriveInfo,
  type NativePhaseTimingEntry,
} from "@bridge/nativeClient";
import { formatBytes, formatCount, lastSegment, type ScanStrategy } from "@bridge/domain";
import { useScanController, type ScanTarget } from "../state/scanController";
import { hostError, portError, rootError } from "../lib/sshTarget";
import { useWorkspace } from "../state/workspaceStore";
import {
  getDefaultEnableIntelligence,
  getDefaultStrategy,
  setDefaultEnableIntelligence,
} from "../lib/prefs";
import type { ScanJobView } from "../hooks/useScanJob";
import { OverlayShell } from "./ui/OverlayShell";
import { Button } from "./ui/Button";
import { Meter, SectionLabel, useCountUp } from "./ui/Card";
import { Tag } from "./ui/Chip";

const STRATEGIES: Array<{
  id: ScanStrategy;
  icon: LucideIcon;
  title: string;
  note: string;
  /** Finding duplicates means reading the files, which only works on this PC. */
  remoteNote?: string;
}> = [
  {
    id: "smart",
    icon: Sparkles,
    title: "Smart",
    note: "sizes, types and duplicate detection",
    remoteNote: "sizes and types — duplicate detection needs files on this PC",
  },
  { id: "metadata", icon: Zap, title: "Metadata only", note: "fastest — sizes and dates" },
];

/** "C:\" — a whole drive, as opposed to a folder inside one. */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;

/** Every text field in this sheet. */
const FIELD =
  "mono rounded-[9px] border border-line-input bg-field px-3 py-2.5 text-12 text-ink placeholder:text-dim focus:border-primary-edge focus:outline-none";

/** "C:\" → "C:" — what the button and the row call it. */
const driveName = (root: string) => root.replace(/[\\/]+$/, "");

/** Names the thing the button will do: "Scan C:", "Scan Projects". */
function scanLabel(target: string): string {
  const t = target.trim();
  if (!t) return "Scan";
  return `Scan ${DRIVE_ROOT.test(t) ? driveName(t) : lastSegment(t)}`;
}

/** How full a drive is, or null when its capacity couldn't be read. */
function usedFraction(drive: NativeDriveInfo): number | null {
  if (drive.total_bytes === null || drive.free_bytes === null || drive.total_bytes <= 0) return null;
  return Math.max(0, Math.min(1, (drive.total_bytes - drive.free_bytes) / drive.total_bytes));
}

/** The fullest drive whose capacity we can read, else C:, else the first one. */
/**
 * The system drive wins, even when a data drive is fuller.
 *
 * The moment that makes someone install this is Windows saying it needs space, and Windows only
 * ever says that about C:. A second drive sitting at 80% is normal and nobody is losing sleep
 * over it. Preselecting the fullest drive would open on D: for most developers and quietly answer
 * a question they didn't ask.
 */
function defaultDrive(drives: NativeDriveInfo[]): NativeDriveInfo | null {
  const system = drives.find((d) => /^c:/i.test(d.root_path));
  if (system) return system;
  const measured = drives.filter((d) => usedFraction(d) !== null);
  if (measured.length) {
    return measured.reduce((a, b) => (usedFraction(b)! > usedFraction(a)! ? b : a));
  }
  return drives[0] ?? null;
}

/**
 * The backend's own phase messages are engineering strings — "progress",
 * "Sampling duplicate candidates", "Enrichment · fs-basic". This is what a
 * person reads instead. Anything unmatched falls through to the walk line
 * rather than putting a DTO string in front of someone.
 */
const PHASE_SAID_PLAINLY: Array<[RegExp, string]> = [
  [/^progress$|^started scan\b/i, "Looking through your folders"],
  [/^Marking missing files$/i, "Checking what's gone since last time"],
  [/^Computing folder totals$/i, "Adding up folder sizes"],
  [/^Building extension statistics$/i, "Sorting files by type"],
  [/^Preparing duplicate analysis$/i, "Lining up files that could be duplicates"],
  [/^Sampling duplicate candidates$/i, "Comparing files that could be duplicates"],
  [/^Full hashing strong matches$/i, "Checking the close matches byte for byte"],
  [/^Building duplicate groups$/i, "Grouping the duplicates it found"],
  [/^Finalizing index$/i, "Saving what it found"],
  [/^Enrichment\b/i, "Working out what's safe to delete"],
  [/^Duplicate analysis complete$|^completed$|^Scan complete$/i, "Done — here's what it found"],
];

function saidPlainly(message: string): string {
  for (const [pattern, text] of PHASE_SAID_PLAINLY) {
    if (pattern.test(message)) return text;
  }
  const failed = message.match(/^error path=(.+) message=/);
  if (failed) return `Couldn't read ${lastSegment(failed[1])}`;
  return "Looking through your folders";
}

/** Phases where progress_total is a count of files, not a 0/1 stage marker. */
const COUNTS_FILES = /^Sampling duplicate candidates$|^Full hashing strong matches$/i;

/** The log phases worth a user's attention — a skipped folder or an unreadable
 *  path. Everything else is developer output and lives behind the disclosure. */
const PROBLEM_PHASE = /^(skip|warn|error)$/;

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
  const [remote, setRemote] = useState(false);
  const [destination, setDestination] = useState("");
  const [port, setPort] = useState("");
  const [remoteFolder, setRemoteFolder] = useState("");
  const [strategy, setStrategy] = useState<ScanStrategy>(getDefaultStrategy);
  const [intelligence, setIntelligence] = useState<boolean>(getDefaultEnableIntelligence);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [native, setNative] = useState(true);
  const [drives, setDrives] = useState<NativeDriveInfo[]>([]);
  const [timings, setTimings] = useState<NativePhaseTimingEntry[] | null>(null);

  useEffect(() => {
    void isNativeRuntime().then(setNative);
  }, []);

  // The drives, listed before anything is asked of the user — never an empty
  // window. An unreadable drive still shows up; it just says so.
  useEffect(() => {
    void listFixedDrives()
      .then((list) => {
        setDrives(list);
        setFolder((current) => current || defaultDrive(list)?.root_path || "");
      })
      .catch(() => setDrives([]));
  }, []);

  // Opening the sheet after a finished (complete/failed/cancelled) job shows
  // the NEW-scan form, not the stale progress screen. A running scan still
  // opens onto its live progress. Keyed on `overlay` only: resetting must
  // happen on open, never the moment a scan finishes while the sheet is up.
  useEffect(() => {
    if (overlay === "scan" && view.status !== "idle" && view.status !== "scanning") {
      reset();
      setQueued(false);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay]);

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
  const host = destination.trim();
  const remoteRoot = remoteFolder.trim();
  // Checked here as well as in the backend: these end up as ssh arguments.
  const badHost = hostError(destination);
  const badPort = portError(port);
  const badRoot = rootError(remoteFolder);
  const remoteError = badHost ?? badPort ?? badRoot;

  /** What the button will scan — null while the form is still incomplete. */
  const target: ScanTarget | null = remote
    ? host && remoteRoot && !remoteError
      ? { destination: host, port: port.trim() ? Number(port.trim()) : undefined, root: remoteRoot }
      : null
    : trimmed || null;

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
    if (!target) return;
    setError(null);
    setQueued(false);
    try {
      // Runs now if idle, otherwise joins the FIFO behind the active scan.
      if (enqueue(target, strategy, intelligence) === "queued") setQueued(true);
    } catch (e) {
      setError(`Couldn't start scan: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const configFooter = (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-105 text-dim">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : remoteError ? (
          <span className="text-danger">{remoteError}</span>
        ) : queued ? (
          "Added to queue — runs after the current scan."
        ) : scanning ? (
          "A scan is already running — starting another adds it to the queue."
        ) : remote ? (
          "Bird's Eye reads the listing over SSH — it copies nothing and installs nothing."
        ) : (
          "Nothing leaves this PC."
        )}
      </span>
      <Button
        variant="primary"
        icon={Play}
        disabled={!target}
        onClick={scanNow}
        title={remote ? (host ? `Scan ${host}` : undefined) : trimmed ? `Scan ${trimmed}` : undefined}
      >
        {remote ? (host ? `Scan ${host}` : "Scan") : scanLabel(trimmed)}
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
          <label className="flex cursor-pointer items-center gap-2.5 rounded-[10px] border border-line-modal p-3 transition-colors hover:border-line-strong">
            <input
              type="checkbox"
              checked={remote}
              onChange={(e) => setRemote(e.target.checked)}
              className="h-3.5 w-3.5 flex-none accent-[var(--color-primary)]"
            />
            <span className="flex flex-none items-center gap-1.5 text-12 font-medium text-ink-soft">
              <Server size={13} strokeWidth={2} aria-hidden />
              Remote host (SSH)
            </span>
            <span className="ml-auto min-w-0 truncate text-105 text-dim">
              Scan a Linux machine instead of this PC
            </span>
          </label>

          {remote ? (
            <section>
              <SectionLabel className="mb-2">Host</SectionLabel>
              <div className="flex gap-2">
                <input
                  aria-label="Remote host"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") scanNow();
                  }}
                  placeholder="user@host"
                  spellCheck={false}
                  className={`${FIELD} min-w-0 flex-1 ${badHost ? "border-danger" : ""}`}
                />
                <input
                  aria-label="Port — leave it empty to use 22"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") scanNow();
                  }}
                  placeholder="22"
                  inputMode="numeric"
                  spellCheck={false}
                  className={`${FIELD} w-20 flex-none ${badPort ? "border-danger" : ""}`}
                />
              </div>

              <SectionLabel className="mb-2 mt-3.5">Folder on that host</SectionLabel>
              <input
                aria-label="Folder on that host"
                value={remoteFolder}
                onChange={(e) => setRemoteFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") scanNow();
                }}
                placeholder="/home/user"
                spellCheck={false}
                className={`${FIELD} w-full ${badRoot ? "border-danger" : ""}`}
              />

              <div className="mt-1.5 text-105 leading-relaxed text-faint">
                Bird's Eye signs in with your SSH key — a host that asks for a password won't work.
                Nothing is installed on it, and no file is copied back.
              </div>
            </section>
          ) : (
            <>
              {drives.length ? (
                <section>
                  <SectionLabel className="mb-2">Your drives</SectionLabel>
                  <div role="radiogroup" aria-label="Drive to scan" className="flex flex-col gap-1.5">
                    {drives.map((d) => (
                      <DriveRow
                        key={d.root_path}
                        drive={d}
                        selected={trimmed.toLowerCase() === d.root_path.toLowerCase()}
                        onSelect={() => setFolder(d.root_path)}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              <section>
                <SectionLabel className="mb-2">Or a folder</SectionLabel>
                <div className="flex gap-2">
                  <input
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") scanNow();
                    }}
                    placeholder="C:\Projects"
                    spellCheck={false}
                    className={`${FIELD} min-w-0 flex-1`}
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
            </>
          )}

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
                    <span className="text-105 leading-relaxed text-dim">
                      {(remote && s.remoteNote) || s.note}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-line-modal p-3 transition-colors hover:border-line-strong">
              <input
                type="checkbox"
                checked={intelligence}
                onChange={(e) => {
                  setIntelligence(e.target.checked);
                  setDefaultEnableIntelligence(e.target.checked); // remembered for next time
                }}
                className="mt-0.5 h-3.5 w-3.5 flex-none accent-[var(--color-primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-12 font-medium text-ink-soft">
                  Work out what's safe to delete
                  <span
                    className="inline-flex text-dim"
                    title={
                      "Bird's Eye reads your folder structure and works out what each folder is, " +
                      "what depends on it and what you can free — so the Map and Clean up " +
                      "can tell you what's safe to delete and why. " +
                      "It reads some file contents (media metadata, image fingerprints) as well as " +
                      "names and sizes. Nothing is uploaded. It runs at the end of this same scan."
                    }
                  >
                    <Info size={12} strokeWidth={2} aria-hidden />
                  </span>
                </span>
                <span className="text-105 leading-relaxed text-dim">
                  Runs with this scan — no second pass needed.
                  {intelligence && strategy === "metadata"
                    ? " Note: this reads some file contents, which goes beyond metadata-only."
                    : ""}
                </span>
              </span>
            </label>
          </section>

          <p className="text-105 leading-relaxed text-faint">
            The first scan takes a few minutes, because it's reading more than sizes. After that it
            only looks at what changed — so the second scan is seconds.
          </p>
        </div>
      )}
    </OverlayShell>
  );
}

/**
 * One drive, the way every radial-consumer tool shows it: name, capacity, and a
 * used bar. A drive whose capacity couldn't be read (locked or unformatted) is
 * still listed — it says its size is unknown rather than claiming 0 B.
 */
function DriveRow({
  drive,
  selected,
  onSelect,
}: {
  drive: NativeDriveInfo;
  selected: boolean;
  onSelect: () => void;
}) {
  const used = usedFraction(drive);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-[10px] border p-3 text-left transition-colors ${
        selected ? "border-primary-edge bg-primary-dim" : "border-line-modal hover:border-line-strong"
      }`}
    >
      <span
        className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg ${
          selected ? "text-primary-ink" : "text-label"
        }`}
        style={{ background: "color-mix(in srgb, var(--color-history) 13%, transparent)" }}
      >
        <HardDrive size={15} strokeWidth={2} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`mono text-12 font-semibold ${selected ? "text-primary-ink" : "text-ink"}`}>
            {driveName(drive.root_path)}
          </span>
          {drive.volume_label ? (
            <span className="truncate text-11 text-muted">{drive.volume_label}</span>
          ) : null}
          <span className="mono ml-auto flex-none text-105 text-dim">
            {used === null
              ? "size unknown"
              : `${formatBytes(drive.free_bytes ?? 0)} free of ${formatBytes(drive.total_bytes ?? 0)}`}
          </span>
        </span>
        {used === null ? (
          <span className="mt-1.5 block text-105 text-faint">
            Bird's Eye couldn't read this drive's size — it may be locked or unformatted.
          </span>
        ) : (
          <Meter
            fraction={used}
            color="var(--color-history)"
            height={6}
            className="mt-2"
          />
        )}
      </span>
    </button>
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
  const problems = view.lines.filter((l) => PROBLEM_PHASE.test(l.phase));

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
          <span className="min-w-0 truncate text-115 text-ink-soft">
            {complete ? "Done — here's what it found" : saidPlainly(view.message)}
          </span>
          {view.pct >= 0 ? (
            <span className="mono flex-none text-11 text-primary-ink">{Math.round(view.pct)}%</span>
          ) : null}
        </div>
        {/* What it's finding, as it finds it — the folder it's in now, and the
            one count the backend genuinely reports for this phase. */}
        {running ? (
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="mono min-w-0 truncate text-105 text-dim" title={view.currentPath || undefined}>
              {view.currentPath || " "}
            </span>
            {COUNTS_FILES.test(view.message) && view.progressTotal > 1 ? (
              <span className="mono flex-none text-105 text-primary-ink">
                {formatCount(view.progressTotal)} files could be duplicates
              </span>
            ) : null}
          </div>
        ) : null}
        {view.pct < 0 && running ? (
          <div style={{ animation: "bePulse 1.6s ease infinite" }}>
            <Meter fraction={1} height={8} />
          </div>
        ) : (
          <Meter fraction={complete ? 1 : Math.max(0, view.pct) / 100} height={8} />
        )}
      </div>

      {/* Things the user should see: what was skipped, and what couldn't be read. */}
      {problems.length ? (
        <div className="flex flex-col gap-1">
          {problems.slice(-5).map((l) => (
            <div key={l.n} className="flex gap-2 text-105 leading-[1.7]">
              <span className={`mono w-10 flex-none ${PHASE_COLOR[l.phase] ?? "text-faint"}`}>
                {l.phase}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted" title={l.message}>
                {l.message}
              </span>
            </div>
          ))}
          {problems.length > 5 ? (
            <div className="text-105 text-faint">
              +{formatCount(problems.length - 5)} more in the details below
            </div>
          ) : null}
        </div>
      ) : null}

      {/* The raw log is developer output — available, never the default view. */}
      <details>
        <summary className="cursor-pointer text-105 text-faint hover:text-ink">
          Details {view.lines.length ? `(${formatCount(view.lines.length)} lines)` : ""}
        </summary>
        <div
          ref={logRef}
          className="mono mt-2 max-h-64 overflow-auto rounded-[9px] bg-field px-3 py-2.5 text-105 leading-[1.7]"
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
      </details>

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
