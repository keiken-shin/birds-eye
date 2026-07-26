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

export type MoveDialogProps = {
  paths: string[];
  onClose: () => void;
  /**
   * Fired whenever files land in the destination, with the subset that moved
   * this round and whether the whole request finished clean. On a partial
   * failure this fires with just the moved subset and `allMoved: false`
   * while the dialog stays open showing the rest; `allMoved: true` always
   * fires right before the dialog closes.
   */
  onMoved: (destination: string, movedPaths: string[], allMoved: boolean) => void;
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
  const [subfolder, setSubfolder] = useState("");
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

  const trimmedDest = dest.trim();
  // The destination field is readOnly in native mode (picked via the OS dialog),
  // so an optional subfolder name is the only way to type a new folder there.
  // `move_files` already creates the destination's parent, so this is frontend-only.
  const target = subfolder.trim() ? joinDest(trimmedDest, subfolder.trim()) : trimmedDest;
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
      const moves = remaining.map((from) => ({ from, to: joinDest(target, baseName(from)) }));
      const result = await moveFiles(moves, indexPath);
      const failedPaths = new Set(result.failed.map((f) => f.path));
      const movedPaths = remaining.filter((p) => !failedPaths.has(p));
      if (movedPaths.length > 0) {
        // Something moved on disk — repaint every lens, and (when nothing is
        // scanning) queue an incremental metadata rescan so rollup sizes self-heal.
        void refreshData();
        if (scanView.status === "idle" && activeEntry?.root_path) {
          enqueue(activeEntry.root_path, "metadata");
        }
        onMoved(target, movedPaths, result.failed.length === 0);
      }
      if (result.failed.length === 0) {
        onClose();
        return;
      }
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
          {/* A large "Select all N loaded" selection (up to SEARCH_LIMIT in
              FilesView) must tell the same story as the relocate gate: every
              name reachable, not just a handful plus a "+N more" count. A
              max-height scroll container over the full list is enough — no
              virtualization, no dialog restructuring. */}
          <div className="max-h-[280px] overflow-y-auto rounded-[9px] border border-line">
            {remaining.map((p) => {
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
          <label className="mt-2 flex flex-col gap-1">
            <span className="text-105 text-faint">New subfolder (optional)</span>
            <input
              value={subfolder}
              onChange={(e) => setSubfolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void confirm();
              }}
              placeholder="e.g. Invoices"
              spellCheck={false}
              className="rounded-[7px] border border-line-input bg-field px-2.5 py-1.5 text-115 text-ink outline-none"
            />
          </label>
          <div className="mt-1.5 text-105 text-faint">
            Moves the file on disk — the index updates and a rescan keeps folder sizes accurate.
          </div>
        </section>
      </div>
    </OverlayShell>,
    document.body
  );
}
