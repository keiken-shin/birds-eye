import { useMemo, useState } from "react";
import { formatBytes } from "@bridge/domain";
import {
  queryNativeDuplicateFiles,
  revealInExplorer,
  type NativeDuplicateFile,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { baseName } from "../lib/discoveries";

const GROUP_LIMIT = 30;
const FILES_PER_GROUP = 50;
const HASH_LABELS: Record<number, string> = { 0: "size match", 2: "sampled", 4: "verified" };

/**
 * Duplicate groups from the scan (independent of cleanup intelligence — the scan's
 * hash pipeline produces these). One card per group, expandable to the member files,
 * each stageable to the Cleanup Tray and revealable in Explorer. Keeping one copy is
 * the user's call: staging leaves whichever files they don't stage untouched.
 */
export function DuplicatesSection() {
  const { overview } = useIndexData();
  const { indexPath, toggleStaged, isStaged } = useWorkspace();
  const [openId, setOpenId] = useState<number | null>(null);
  const [filesByGroup, setFilesByGroup] = useState<Record<number, NativeDuplicateFile[]>>({});
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      (overview?.duplicate_groups ?? [])
        .slice()
        .sort((a, b) => b.reclaimable_bytes - a.reclaimable_bytes)
        .slice(0, GROUP_LIMIT),
    [overview]
  );

  if (!groups.length) return null;

  const totalReclaimable = groups.reduce((s, g) => s + g.reclaimable_bytes, 0);

  const toggleOpen = (id: number) => {
    setError(null);
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    if (!filesByGroup[id] && indexPath) {
      queryNativeDuplicateFiles(indexPath, id, FILES_PER_GROUP)
        .then((files) => setFilesByGroup((m) => ({ ...m, [id]: files })))
        .catch((e) => setError(String(e)));
    }
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <span className="text-10 uppercase tracking-[0.14em] text-label">
          duplicates · {groups.length} groups
        </span>
        <span className="mono text-10 text-primary-ink">
          ↑ {formatBytes(totalReclaimable)} reclaimable
        </span>
      </div>
      {error && (
        <div className="mb-2 rounded-[7px] border border-danger/30 bg-danger/[0.08] px-3 py-1.5 text-11 text-danger">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {groups.map((g) => {
          const open = openId === g.id;
          const files = filesByGroup[g.id];
          return (
            <div key={g.id} className="rounded-[11px] border border-line bg-panel">
              <button
                type="button"
                onClick={() => toggleOpen(g.id)}
                className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
              >
                <span className="text-11 text-dim">{open ? "▾" : "▸"}</span>
                <span className="text-12 font-medium">
                  {g.file_count} × {formatBytes(g.size)}
                </span>
                <span className="mono text-10 text-dim">
                  {(g.confidence * 100).toFixed(0)}% match
                </span>
                <span className="mono ml-auto text-11 text-primary-ink">
                  ↑ {formatBytes(g.reclaimable_bytes)}
                </span>
              </button>

              {open && (
                <div className="border-t border-line px-3.5 py-2">
                  {!files ? (
                    <div className="py-2 text-11 italic text-label">Loading files…</div>
                  ) : (
                    files.map((f) => {
                      const staged = isStaged(f.path);
                      return (
                        <div key={f.path} className="flex items-center gap-2.5 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-12">{baseName(f.path)}</div>
                            <div className="mono truncate text-[10px] text-dim" title={f.path}>
                              {f.path}
                            </div>
                          </div>
                          <span className="mono flex-none text-10 text-label">
                            {HASH_LABELS[f.hash_state] ?? ""}
                          </span>
                          <button
                            type="button"
                            title="Reveal in Explorer"
                            onClick={() => void revealInExplorer(f.path).catch(() => {})}
                            className="flex-none rounded-[6px] border border-line px-2 py-1 text-10 text-muted hover:text-ink"
                          >
                            ⌖
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              toggleStaged({
                                path: f.path,
                                name: baseName(f.path),
                                bytes: f.size,
                                reason: null,
                                verdict: "review",
                                kind: "file",
                              })
                            }
                            className="flex-none rounded-[6px] px-2.5 py-1 text-10 font-semibold"
                            style={
                              staged
                                ? { background: "rgba(61,220,132,.13)", color: "#7fe0a6", border: "1px solid rgba(61,220,132,.4)" }
                                : { background: "var(--color-primary)", color: "var(--color-on-primary)" }
                            }
                          >
                            {staged ? "✓ Staged" : "Stage"}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
