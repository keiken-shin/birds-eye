import { useEffect } from "react";
import { formatBytes, formatCount } from "@bridge/domain";
import { REASON_LABELS, type NativeTreemapLensFolder } from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { VERDICT_STYLES, canStage, explainFolder, verdictForFolder } from "../lib/verdict";
import { EnableIntelligenceCard } from "./EnableIntelligenceCard";

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-10 tracking-[0.12em] text-label">{children}</div>;
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 rounded-[8px] border border-line bg-inset px-2.5 py-2.5">
      <div className="text-[9.5px] tracking-[0.08em] text-label">{label}</div>
      <div className="mono mt-0.5 text-[16px]">{children}</div>
    </div>
  );
}

export function Inspector() {
  const { tree, lensByPath } = useIndexData();
  const { selected, ontologyEnabled, isStaged, toggleStaged, pinToBoard, unpinCard, isPinned } =
    useWorkspace();

  const node = selected ? tree?.byPath.get(selected.path) : undefined;
  const pinned = selected ? isPinned(selected.path) : false;
  const lensRow: NativeTreemapLensFolder | null = selected ? lensByPath.get(selected.path) ?? null : null;
  const verdict = selected && ontologyEnabled && lensRow ? verdictForFolder(lensRow) : null;
  const vs = verdict ? VERDICT_STYLES[verdict] : null;
  const reclaimable = lensRow?.reclaimable_bytes ?? 0;
  const reasonLabel = lensRow?.cleanup_reason
    ? REASON_LABELS[lensRow.cleanup_reason] ?? lensRow.cleanup_reason
    : null;
  const isFile = selected?.kind === "file";
  const staged = selected ? isStaged(selected.path) : false;
  const stageable = verdict ? canStage(verdict, reclaimable) : false;

  const onStage = () => {
    if (!selected || !verdict) return;
    toggleStaged({
      path: selected.path,
      name: selected.name,
      bytes: reclaimable > 0 ? reclaimable : selected.bytes,
      reason: lensRow?.cleanup_reason ?? null,
      verdict,
      kind: "folder",
    });
  };

  const onStageFile = () => {
    if (!selected) return;
    toggleStaged({ path: selected.path, name: selected.name, bytes: selected.bytes, reason: null, verdict: "review", kind: "file" });
  };

  // ⇧↵ stages the current selection — same gating as the button below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (isFile) onStageFile();
      else if (ontologyEnabled && (stageable || staged) && verdict !== "protected") onStage();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex w-[316px] flex-none flex-col border-l border-line bg-panel">
      <div className="px-3.5 pt-3.5 text-10 tracking-[0.14em] text-label">INSPECTOR</div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5 pt-2.5">
        {!selected ? (
          <div className="mt-10 text-center text-12 italic text-label">
            Select a folder on the map to inspect why it exists and whether it's safe to remove.
          </div>
        ) : (
          <>
            <div className="mb-0.5 flex items-center gap-2.5">
              <span className="text-[16px]">◇</span>
              <span className="text-[16px] font-semibold">{selected.name}</span>
            </div>
            <div className="mono mb-4 break-all text-[10.5px] text-dim">{selected.path}</div>

            <div className="mb-4 flex gap-2">
              <Stat label="SIZE">{formatBytes(selected.bytes)}</Stat>
              {!isFile && <Stat label="FILES">{node ? formatCount(node.files) : "—"}</Stat>}
            </div>

            {isFile ? (
              <>
                <div className="mb-3 text-[11.5px] leading-relaxed text-label">
                  A single file from the results. Folder-level verdicts and "why it exists" live on
                  the map — select its folder there for the full picture. Stage it below to add it
                  to the cleanup tray (it's re-verified before anything is removed).
                </div>
                <button
                  type="button"
                  onClick={() =>
                    selected &&
                    (pinned
                      ? unpinCard(selected.path)
                      : pinToBoard({ path: selected.path, name: selected.name, bytes: selected.bytes }))
                  }
                  className="inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-11"
                  style={
                    pinned
                      ? { borderColor: "rgba(61,220,132,.4)", color: "#7fe0a6" }
                      : { borderColor: "var(--color-line)", color: "var(--color-ink-soft)" }
                  }
                >
                  {pinned ? "✓ On board" : "⬡ Pin to board"}
                </button>
              </>
            ) : !ontologyEnabled ? (
              <EnableIntelligenceCard />
            ) : (
              <>
                <Label>WHY IT EXISTS</Label>
                <div className="mb-4 text-[12.5px] leading-relaxed text-ink-soft">
                  {lensRow
                    ? explainFolder(lensRow)
                    : "Not yet classified — re-run enrichment to analyze this folder."}
                </div>

                <Label>RELATED</Label>
                <div className="mb-2 text-[11.5px] leading-relaxed text-label">
                  Suggested relationships (derived-from / backup-of) for this index live on the
                  Board lens. Pin this folder to collect it there.
                </div>
                <button
                  type="button"
                  onClick={() =>
                    selected &&
                    (pinned
                      ? unpinCard(selected.path)
                      : pinToBoard({ path: selected.path, name: selected.name, bytes: selected.bytes }))
                  }
                  className="mb-4 inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-11"
                  style={
                    pinned
                      ? { borderColor: "rgba(61,220,132,.4)", color: "#7fe0a6" }
                      : { borderColor: "var(--color-line)", color: "var(--color-ink-soft)" }
                  }
                >
                  {pinned ? "✓ On board" : "⬡ Pin to board"}
                </button>

                <Label>SAFETY VERDICT</Label>
                {vs ? (
                  <div
                    className="mb-1 rounded-[9px] p-3"
                    style={{ background: vs.bg, border: "1px solid " + vs.bd, color: vs.tx }}
                  >
                    <div className="mb-1 flex items-center gap-2 text-13 font-semibold">
                      {vs.icon} {vs.label}
                    </div>
                    <div className="text-[11.5px] leading-snug opacity-90">
                      {reclaimable > 0
                        ? `${formatBytes(reclaimable)} reclaimable${reasonLabel ? ` · ${reasonLabel}` : ""}`
                        : verdict === "protected"
                          ? "Protected — never auto-staged."
                          : "In active use — nothing reclaimable."}
                    </div>
                  </div>
                ) : (
                  <div className="text-[11.5px] italic text-label">Not classified.</div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {selected && isFile && (
        <div className="flex-none border-t border-line p-3.5">
          <button
            type="button"
            onClick={onStageFile}
            className="w-full rounded-[9px] py-2.5 text-13 font-semibold"
            style={
              staged
                ? { background: "rgba(61,220,132,.13)", color: "#7fe0a6", border: "1px solid rgba(61,220,132,.4)" }
                : { background: "var(--color-primary)", color: "var(--color-on-primary)" }
            }
          >
            {staged ? "✓ Staged — remove" : "Add to cleanup tray"}
          </button>
        </div>
      )}

      {selected && !isFile && ontologyEnabled && (
        <div className="flex-none border-t border-line p-3.5">
          <button
            type="button"
            disabled={!stageable && !staged}
            onClick={onStage}
            className="w-full rounded-[9px] py-2.5 text-13 font-semibold"
            style={
              verdict === "protected"
                ? { background: "#191c22", color: "#5b616a", cursor: "not-allowed" }
                : staged
                  ? { background: "rgba(61,220,132,.13)", color: "#7fe0a6", border: "1px solid rgba(61,220,132,.4)" }
                  : stageable
                    ? { background: "var(--color-primary)", color: "var(--color-on-primary)" }
                    : { background: "#191c22", color: "#5b616a", cursor: "not-allowed" }
            }
          >
            {verdict === "protected"
              ? "Protected — cannot stage"
              : staged
                ? "✓ Staged — remove"
                : stageable
                  ? "Add to cleanup tray"
                  : "Nothing to reclaim"}
          </button>
        </div>
      )}
    </div>
  );
}
