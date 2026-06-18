import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes } from "@bridge/domain";
import {
  confirmDiscovery,
  listDiscoveries,
  rejectDiscovery,
  type NativeDiscovery,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { FINDING_KINDS, baseName, parseFinding, type Finding } from "../lib/discoveries";
import { VERDICT_STYLES, verdictForFolder } from "../lib/verdict";
import { EnableIntelligenceCard } from "./EnableIntelligenceCard";
import type { PinnedCard } from "../state/types";

/**
 * Board lens — a canvas of findings and pinned folders. Each finding is one discovery
 * (a provenance relation candidate); the card draws the edge subject → object from the
 * payload, with confidence + reclaimable bytes and Confirm/Reject. Confirm writes the fact
 * (it is NOT staging — that's the Cleanup Tray's separate path). Folder cards are pinned
 * from the Inspector and stay Inspector-able; finding endpoints are files and self-contained.
 *
 * ponytail: auto-flow wrap + native scroll, no drag-to-reposition and no minimap — the
 * scrollbar navigates and the wireframe left Board a placeholder. Add an absolute canvas +
 * minimap when findings routinely overflow a screen and spatial arrangement earns its keep.
 */
export function BoardLens() {
  const { ontologyEnabled, indexPath, pinned, unpinCard, select, selected } = useWorkspace();
  const { lensByPath, dataVersion } = useIndexData();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async () => {
    if (!indexPath || !ontologyEnabled) {
      setFindings([]);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const lists = await Promise.all(
        FINDING_KINDS.map((k) =>
          listDiscoveries(indexPath, k, 60).catch(() => [] as NativeDiscovery[])
        )
      );
      if (id !== reqId.current) return; // superseded by a newer index/enable
      const all = lists
        .flat()
        .filter((d) => d.status === "Pending")
        .map(parseFinding)
        .filter((f): f is Finding => f !== null)
        .sort((a, b) => b.bytes - a.bytes);
      setFindings(all);
    } catch (e) {
      if (id === reqId.current) setError(String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
    // dataVersion: refetch after refreshData (e.g. enabling intelligence from the Board, which
    // enriches then refreshes) so findings populate instead of sticking on the pre-enrich empty.
  }, [indexPath, ontologyEnabled, dataVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (id: number, fn: () => Promise<void>) => {
      setBusyId(id);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  if (!ontologyEnabled) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-[440px]">
          <div className="mb-3 text-center text-12 text-label">
            The Board shows relationships found during enrichment — enable intelligence to
            populate it.
          </div>
          <EnableIntelligenceCard />
        </div>
      </div>
    );
  }

  const empty = !loading && !findings.length && !pinned.length;

  return (
    <div className="relative min-h-0 flex-1 overflow-auto p-5">
      {error && (
        <div className="mb-3 rounded-[8px] border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-11 text-red-300">
          {error}
        </div>
      )}

      {empty ? (
        <div className="flex h-full items-center justify-center text-center text-12 italic text-label">
          No relationships found yet. Confirm findings from enrichment, or pin a folder
          <br />
          from the map (Inspector → Pin to board).
        </div>
      ) : (
        <div className="flex flex-wrap content-start gap-4">
          {pinned.map((card) => (
            <PinnedCardView
              key={`pin:${card.path}`}
              card={card}
              selected={selected?.path === card.path}
              verdict={
                lensByPath.get(card.path) ? verdictForFolder(lensByPath.get(card.path)!) : null
              }
              onSelect={() => select({ kind: "folder", path: card.path, name: card.name, bytes: card.bytes })}
              onUnpin={() => unpinCard(card.path)}
            />
          ))}
          {findings.map((f) => (
            <FindingCardView
              key={f.id}
              f={f}
              busy={busyId === f.id}
              onConfirm={() => void act(f.id, () => confirmDiscovery(indexPath!, f.id))}
              onReject={() => void act(f.id, () => rejectDiscovery(indexPath!, f.id))}
            />
          ))}
        </div>
      )}

      {loading && !findings.length && (
        <div className="mt-4 text-12 italic text-label">Loading findings…</div>
      )}
    </div>
  );
}

function PathChip({ path, accent }: { path: string; accent?: boolean }) {
  return (
    <div
      title={path}
      className="rounded-[7px] border px-2.5 py-1.5"
      style={{
        borderColor: accent ? "rgba(61,220,132,.3)" : "var(--color-line)",
        background: accent ? "rgba(61,220,132,.06)" : "var(--color-inset)",
      }}
    >
      <div className="truncate text-12 font-medium">{baseName(path)}</div>
      <div className="mono truncate text-[10px] text-dim">{path}</div>
    </div>
  );
}

function FindingCardView({
  f,
  busy,
  onConfirm,
  onReject,
}: {
  f: Finding;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <div className="w-[300px] rounded-[11px] border border-line bg-panel p-3.5">
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-[5px] bg-primary/[0.1] px-2 py-0.5 text-10 font-semibold uppercase tracking-[0.1em] text-primary-ink">
          finding
        </span>
        <span className="mono text-10 text-dim">{(f.confidence * 100).toFixed(0)}% confident</span>
      </div>

      {/* The edge: subject (reclaimable) ──predicate──▶ object (original it depends on). */}
      <PathChip path={f.subject} accent />
      <div className="my-1.5 flex items-center gap-2 pl-3 text-10 text-label">
        <span className="text-primary-ink">↓</span>
        <span className="italic">{f.predicate}</span>
      </div>
      <PathChip path={f.object} />

      <div className="mono mt-3 text-11 text-primary-ink">
        ↑ {formatBytes(f.bytes)} reclaimable if confirmed
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="flex-1 rounded-[7px] bg-primary py-1.5 text-11 font-semibold text-on-primary disabled:opacity-50"
        >
          Confirm
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReject}
          className="flex-1 rounded-[7px] border border-white/15 py-1.5 text-11 text-white/60 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

function PinnedCardView({
  card,
  verdict,
  selected,
  onSelect,
  onUnpin,
}: {
  card: PinnedCard;
  verdict: ReturnType<typeof verdictForFolder> | null;
  selected: boolean;
  onSelect: () => void;
  onUnpin: () => void;
}) {
  const vs = verdict ? VERDICT_STYLES[verdict] : null;
  return (
    <div
      onClick={onSelect}
      className="w-[300px] cursor-pointer rounded-[11px] border bg-panel p-3.5"
      style={{
        borderColor: selected ? "#3ddc84" : "var(--color-line)",
        boxShadow: selected ? "0 0 0 1px #3ddc84" : "none",
      }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[15px]">◇</span>
        <span className="min-w-0 flex-1 truncate text-13 font-semibold">{card.name}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onUnpin();
          }}
          className="flex-none text-dim hover:text-white"
          title="Remove from board"
        >
          ✕
        </button>
      </div>
      <div className="mono mb-2 truncate text-[10px] text-dim">{card.path}</div>
      <div className="mono text-11 text-muted">{formatBytes(card.bytes)}</div>
      {vs && (
        <div
          className="mt-2 inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-10"
          style={{ background: vs.bg, border: "1px solid " + vs.bd, color: vs.tx }}
        >
          {vs.icon} {vs.label}
        </div>
      )}
    </div>
  );
}
