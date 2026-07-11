import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import {
  chooseNativeFolder,
  isNativeRuntime,
  moveFiles,
  type NativeMoveFailure,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { useScanController } from "../state/scanController";
import { baseName } from "../lib/discoveries";
import { OverlayShell } from "./ui/OverlayShell";
import { Button } from "./ui/Button";
import { SectionLabel } from "./ui/Card";

const SHOWN_LIMIT = 5;

export type MoveDialogProps = {
  paths: string[];
  onClose: () => void;
  /** Fired once every file landed in the destination (just before the dialog closes). */
  onMoved: () => void;
};

/** Join destination + basename using the separator style the destination uses (default \). */
function joinDest(dest: string, name: string) {
  const sep = dest.includes("/") && !dest.includes("\\") ? "/" : "\\";
  return dest.replace(/[\\/]+$/, "") + sep + name;
}

/**
 * "Move to folder" dialog — moves files on disk via the native bridge, then
 * refreshes the index and quietly queues an incremental rescan so folder
 * rollups self-heal. Hosts only own the open/closed state; everything else
 * (destination, per-file failures, refresh) lives here.
 */
export function MoveDialog({ paths, onClose, onMoved }: MoveDialogProps) {
  const { indexPath } = useWorkspace();
  const { overview, activeEntry, refreshData } = useIndexData();
  const { view: scanView, enqueue } = useScanController();

  const [native, setNative] = useState(false);
  const [dest, setDest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Paths still to move — shrinks to the failed set after a partial failure. */
  const [remaining, setRemaining] = useState(paths);
  const [failures, setFailures] = useState<NativeMoveFailure[]>([]);

  useEffect(() => {
    let alive = true;
    void isNativeRuntime()
      .then((v) => alive && setNative(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Escape closes the dialog (capture-phase so the shell's Escape handling stays quiet).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const sizeByPath = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of overview?.files ?? []) m.set(f.path, f.size);
    return m;
  }, [overview]);

  const failureByPath = useMemo(() => new Map(failures.map((f) => [f.path, f.reason])), [failures]);

  const shown = remaining.slice(0, SHOWN_LIMIT);
  const extra = remaining.length - shown.length;
  const trimmedDest = dest.trim();
  const noun = remaining.length === 1 ? "file" : "files";

  const browse = async () => {
    setError(null);
    try {
      const picked = await chooseNativeFolder();
      if (picked) setDest(picked);
    } catch (e) {
      setError(`Folder picker failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const confirm = async () => {
    if (!trimmedDest || busy || !remaining.length) return;
    setBusy(true);
    setError(null);
    try {
      const moves = remaining.map((from) => ({ from, to: joinDest(trimmedDest, baseName(from)) }));
      const result = await moveFiles(moves, indexPath);
      if (result.failed.length < remaining.length) {
        // Something moved on disk — repaint every lens, and (when nothing is
        // scanning) queue an incremental metadata rescan so rollup sizes self-heal.
        void refreshData();
        if (scanView.status === "idle" && activeEntry?.root_path) {
          enqueue(activeEntry.root_path, "metadata");
        }
      }
      if (result.failed.length === 0) {
        onMoved();
        onClose();
        return;
      }
      const failedPaths = new Set(result.failed.map((f) => f.path));
      setRemaining((prev) => prev.filter((p) => failedPaths.has(p)));
      setFailures(result.failed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const footer = (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-105 text-dim">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : failures.length ? (
          <span className="text-danger">
            {failures.length} of {paths.length} couldn't be moved — the rest were.
          </span>
        ) : busy ? (
          "Moving files…"
        ) : null}
      </span>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
      <Button
        variant="primary"
        disabled={!trimmedDest || busy || !remaining.length}
        onClick={() => void confirm()}
      >
        {busy ? "Moving…" : `Move ${remaining.length} ${noun}`}
      </Button>
    </div>
  );

  // Portaled to <body>: hosts live inside positioned panels, and the shell's
  // absolute backdrop must cover the whole window, not just the host pane.
  return createPortal(
    <OverlayShell
      title="Move to folder"
      meta={`${remaining.length} ${noun}`}
      width={480}
      locked={busy}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={footer}
    >
      <div className="flex flex-col gap-4 px-4.5 py-4">
        <section>
          <SectionLabel className="mb-2">Files to move</SectionLabel>
          <div className="overflow-hidden rounded-[9px] border border-line">
            {shown.map((p) => {
              const reason = failureByPath.get(p);
              const size = sizeByPath.get(p);
              return (
                <div key={p} className="border-b border-line-soft px-3 py-2 last:border-b-0">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-12 font-medium text-ink">
                      {baseName(p)}
                    </span>
                    {size != null ? (
                      <span className="mono flex-none text-10 text-muted">{formatBytes(size)}</span>
                    ) : null}
                  </div>
                  <div className="mono truncate text-10 text-dim" title={p}>
                    {p}
                  </div>
                  {reason ? (
                    <div className="mt-1 text-105 text-danger">Couldn't move — {reason}</div>
                  ) : null}
                </div>
              );
            })}
            {extra > 0 ? (
              <div className="px-3 py-1.5 text-105 text-faint">+{extra} more</div>
            ) : null}
          </div>
        </section>

        <section>
          <SectionLabel className="mb-2">Destination</SectionLabel>
          <div className="flex gap-2">
            <input
              value={dest}
              readOnly={native}
              onChange={(e) => setDest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirm();
              }}
              placeholder={native ? "Choose a folder…" : "Paste a destination folder path…"}
              spellCheck={false}
              aria-label="Destination folder"
              className="mono min-w-0 flex-1 rounded-[9px] border border-line-input bg-field px-3 py-2.5 text-12 text-ink placeholder:text-dim focus:border-primary-edge focus:outline-none"
            />
            {native ? (
              <Button variant="ghost" icon={FolderOpen} onClick={() => void browse()}>
                Browse
              </Button>
            ) : null}
          </div>
          <div className="mt-1.5 text-105 text-faint">
            Moves the file on disk — the index updates and a rescan keeps folder sizes accurate.
          </div>
        </section>
      </div>
    </OverlayShell>,
    document.body
  );
}
