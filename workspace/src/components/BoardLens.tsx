import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "@bridge/domain";
import {
  confirmDiscovery,
  confirmDiscoveryPattern,
  listDiscoveries,
  rejectDiscovery,
  rejectDiscoveryPattern,
  type NativeDiscovery,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { FINDING_KINDS, baseName, parseFinding, type Finding } from "../lib/discoveries";
import { VERDICT_STYLES, verdictForFolder } from "../lib/verdict";
import { EnableIntelligenceCard } from "./EnableIntelligenceCard";
import type { PinnedCard } from "../state/types";

/**
 * The Investigation Board (Architecture B): an open canvas you pan and zoom, where
 * findings, pinned folders, and the duplicates summary live as draggable cards with
 * relationship edges drawn between them. Positions persist per index — the spatial
 * arrangement IS the investigation.
 */

type CardModel =
  | { id: string; kind: "pin"; pin: PinnedCard }
  | { id: string; kind: "finding"; finding: Finding }
  | { id: string; kind: "dups"; groups: number; reclaimable: number }
  | { id: string; kind: "enable" };

type Pos = { x: number; y: number };

const CARD_W = 300;
const CARD_H: Record<CardModel["kind"], number> = { pin: 128, finding: 216, dups: 118, enable: 190 };
const GRID_X = CARD_W + 40;
const GRID_Y = 250;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

const posKey = (indexPath: string) => `be.ws.board.pos:${indexPath}`;

function loadPositions(indexPath: string | null): Record<string, Pos> {
  if (!indexPath) return {};
  try {
    return JSON.parse(localStorage.getItem(posKey(indexPath)) ?? "{}") as Record<string, Pos>;
  } catch {
    return {};
  }
}

export function BoardLens() {
  const { ontologyEnabled, indexPath, pinned, unpinCard, select, selected, setOverlay } =
    useWorkspace();
  const { lensByPath, dataVersion, overview, ontology, activeEntry } = useIndexData();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  // ---- data ----
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
      if (id !== reqId.current) return;
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
    // dataVersion: refetch after refreshData so findings track enrichment progress.
  }, [indexPath, ontologyEnabled, dataVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a scan/enrichment job is live, refresh findings periodically so they
  // stream onto the board instead of appearing all at once at the end.
  const { view: jobView, enqueue } = useScanController();
  const jobActive = jobView.status === "scanning";
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [jobActive, load]);

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

  const actKind = useCallback(
    async (kind: string, fn: () => Promise<number>) => {
      setBusyKind(kind);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyKind(null);
      }
    },
    [load]
  );

  // ---- card models ----
  const dupGroups = overview?.duplicate_groups ?? [];
  const cards = useMemo<CardModel[]>(() => {
    const out: CardModel[] = [];
    if (!ontologyEnabled) out.push({ id: "enable", kind: "enable" });
    if (dupGroups.length) {
      out.push({
        id: "dups",
        kind: "dups",
        groups: dupGroups.length,
        reclaimable: dupGroups.reduce((s, g) => s + g.reclaimable_bytes, 0),
      });
    }
    for (const pin of pinned) out.push({ id: `pin:${pin.path}`, kind: "pin", pin });
    for (const f of findings) out.push({ id: `find:${f.id}`, kind: "finding", finding: f });
    return out;
  }, [ontologyEnabled, dupGroups, pinned, findings]);

  // ---- spatial state ----
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pan, setPan] = useState<Pos>({ x: 24, y: 24 });
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Record<string, Pos>>(() => loadPositions(indexPath));
  const drag = useRef<
    | { mode: "pan"; startX: number; startY: number; panX: number; panY: number }
    | { mode: "card"; id: string; offX: number; offY: number }
    | null
  >(null);

  useEffect(() => {
    setPositions(loadPositions(indexPath));
  }, [indexPath]);

  const savePositions = useCallback(
    (next: Record<string, Pos>) => {
      if (indexPath) localStorage.setItem(posKey(indexPath), JSON.stringify(next));
    },
    [indexPath]
  );

  // Default layout for cards without a saved position: a simple grid, pins/dups first.
  const placed = useMemo(() => {
    const out = new Map<string, Pos>();
    let i = 0;
    for (const card of cards) {
      const saved = positions[card.id];
      out.set(card.id, saved ?? { x: (i % 4) * GRID_X, y: Math.floor(i / 4) * GRID_Y });
      i++;
    }
    return out;
  }, [cards, positions]);

  // Edges: a pinned folder connects to findings whose endpoints live under it.
  const edges = useMemo(() => {
    const out: Array<{ from: Pos; to: Pos; key: string }> = [];
    for (const card of cards) {
      if (card.kind !== "finding") continue;
      const fPos = placed.get(card.id);
      if (!fPos) continue;
      for (const pin of pinned) {
        const under = (p: string) =>
          p === pin.path || p.startsWith(pin.path + "/") || p.startsWith(pin.path + "\\");
        if (under(card.finding.subject) || under(card.finding.object)) {
          const pPos = placed.get(`pin:${pin.path}`);
          if (pPos) {
            out.push({
              key: `${card.id}~${pin.path}`,
              from: { x: pPos.x + CARD_W / 2, y: pPos.y + CARD_H.pin / 2 },
              to: { x: fPos.x + CARD_W / 2, y: fPos.y + CARD_H.finding / 2 },
            });
          }
        }
      }
    }
    return out;
  }, [cards, placed, pinned]);

  // ---- pointer interactions ----
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom((z) => {
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.12 : 0.89)));
        setPan((p) => ({ x: cx - ((cx - p.x) * nz) / z, y: cy - ((cy - p.y) * nz) / z }));
        return nz;
      });
    },
    []
  );

  const onBackgroundDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-board-card]")) return;
      drag.current = { mode: "pan", startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pan]
  );

  const onCardDown = useCallback(
    (id: string) => (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button, input, a, video, audio")) return;
      e.stopPropagation();
      const pos = placed.get(id) ?? { x: 0, y: 0 };
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const canvasX = (e.clientX - rect.left - pan.x) / zoom;
      const canvasY = (e.clientY - rect.top - pan.y) / zoom;
      drag.current = { mode: "card", id, offX: canvasX - pos.x, offY: canvasY - pos.y };
      wrapRef.current?.setPointerCapture(e.pointerId);
    },
    [placed, pan, zoom]
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.mode === "pan") {
        setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
      } else {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        const canvasX = (e.clientX - rect.left - pan.x) / zoom;
        const canvasY = (e.clientY - rect.top - pan.y) / zoom;
        setPositions((prev) => ({ ...prev, [d.id]: { x: canvasX - d.offX, y: canvasY - d.offY } }));
      }
    },
    [pan, zoom]
  );

  const onUp = useCallback(() => {
    if (drag.current?.mode === "card") {
      setPositions((prev) => {
        savePositions(prev);
        return prev;
      });
    }
    drag.current = null;
  }, [savePositions]);

  // ---- enrichment status ----
  // The progress bar shows only while a job is actually streaming (live truth).
  // State rows saying running/paused with NO active job mean an interrupted pass —
  // that gets an explicit amber chip with a Resume action, never a frozen "running".
  const liveEnrich = jobActive && jobView.message.startsWith("Enrichment") ? jobView : null;
  // Optional-chain populators: a hot-reloaded frontend can briefly talk to an older
  // backend whose status payload lacks the field — degrade, don't crash the Board.
  const interrupted =
    !jobActive &&
    (ontology?.populators?.some((p) => p.status === "running" || p.status === "paused") ?? false);
  const failed = ontology?.populators?.filter((p) => p.status === "failed") ?? [];
  const resumeEnrichment = () => {
    if (!activeEntry?.root_path) {
      setError("Can't resume — this index has no recorded scan root. Run a new scan (Ctrl+N).");
      return;
    }
    const outcome = enqueue(activeEntry.root_path, activeEntry.scan_strategy ?? "smart");
    // The scan sheet is where live progress and logs render; the queue overlay only
    // lists indexes. Follow the job to the right surface.
    setOverlay(outcome === "started" ? "scan" : "queue");
  };

  const empty = !loading && !cards.length;

  return (
    <div
      ref={wrapRef}
      className="relative min-h-0 flex-1 touch-none select-none overflow-hidden"
      style={{
        cursor: "grab",
        backgroundImage: "radial-gradient(circle, #1a1d23 1px, transparent 1px)",
        backgroundSize: "26px 26px",
      }}
      onWheel={onWheel}
      onPointerDown={onBackgroundDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {/* fixed toolbar */}
      <div className="pointer-events-none absolute left-0 right-0 top-0 z-20 flex items-center gap-2 px-4 py-2.5">
        <div className="pointer-events-auto flex items-center gap-2">
          {FINDING_KINDS.map((kind) => {
            const group = findings.filter((f) => f.kind === kind);
            if (group.length < 2) return null;
            return (
              <span key={kind} className="flex items-center gap-1.5 rounded-[8px] border border-line bg-panel/90 px-2.5 py-1">
                <span className="text-10 uppercase tracking-[0.1em] text-label">
                  {group[0].predicate} · {group.length}
                </span>
                <button
                  type="button"
                  disabled={busyKind === kind}
                  onClick={() => void actKind(kind, () => confirmDiscoveryPattern(indexPath!, kind))}
                  className="rounded-[5px] border border-primary/40 px-1.5 py-0.5 text-10 font-semibold text-primary-ink disabled:opacity-50"
                >
                  Confirm all
                </button>
                <button
                  type="button"
                  disabled={busyKind === kind}
                  onClick={() => void actKind(kind, () => rejectDiscoveryPattern(indexPath!, kind))}
                  className="rounded-[5px] border border-white/15 px-1.5 py-0.5 text-10 text-white/60 disabled:opacity-50"
                >
                  Reject all
                </button>
              </span>
            );
          })}
          {liveEnrich && (
            <span className="flex items-center gap-2 rounded-[8px] border border-primary/30 bg-panel/90 px-2.5 py-1 text-10 text-primary-ink">
              <span>⟳ {liveEnrich.message.replace("Enrichment · ", "enrichment · ")}</span>
              <span className="relative h-[4px] w-[90px] overflow-hidden rounded-full bg-white/10">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${Math.max(2, liveEnrich.pct)}%` }}
                />
              </span>
              <span className="mono">{Math.max(0, Math.round(liveEnrich.pct))}%</span>
            </span>
          )}
          {interrupted && (
            <span className="flex items-center gap-2 rounded-[8px] border border-warn/40 bg-panel/90 px-2.5 py-1 text-10 text-warn">
              <span>⏸ enrichment interrupted — findings are incomplete</span>
              <button
                type="button"
                onClick={resumeEnrichment}
                className="rounded-[5px] border border-warn/40 px-1.5 py-0.5 text-10 font-semibold text-warn"
              >
                Resume
              </button>
            </span>
          )}
          {failed.length > 0 && (
            <span className="rounded-[8px] border border-danger/30 bg-panel/90 px-2.5 py-1 text-10 text-danger" title={failed[0].last_error ?? undefined}>
              ⚠ {failed.map((p) => p.name).join(", ")} failed — re-run from Settings
            </span>
          )}
        </div>
        <div className="pointer-events-auto ml-auto flex items-center gap-1.5">
          <span className="mono text-10 text-dim">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => {
              setZoom(1);
              setPan({ x: 24, y: 24 });
            }}
            className="rounded-[6px] border border-line bg-panel/90 px-2 py-0.5 text-10 text-muted hover:text-ink"
          >
            Reset view
          </button>
        </div>
      </div>

      {error && (
        <div className="absolute left-4 top-12 z-20 rounded-[8px] border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-11 text-red-300">
          {error}
        </div>
      )}

      {empty && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-center text-12 italic text-label">
          {liveEnrich
            ? "Enrichment is running — findings appear here as they're discovered."
            : interrupted
              ? "Enrichment was interrupted before finishing — resume it from the chip above."
              : "Nothing on the board yet. Findings land here after enrichment; pin folders from the Inspector."}
        </div>
      )}

      {/* pannable/zoomable content */}
      <div
        className="absolute left-0 top-0"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
      >
        <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
          {edges.map((e) => (
            <line
              key={e.key}
              x1={e.from.x}
              y1={e.from.y}
              x2={e.to.x}
              y2={e.to.y}
              stroke="rgba(61,220,132,.25)"
              strokeWidth={1.5 / zoom}
              strokeDasharray="5 4"
            />
          ))}
        </svg>

        {cards.map((card) => {
          const pos = placed.get(card.id)!;
          return (
            <div
              key={card.id}
              data-board-card
              onPointerDown={onCardDown(card.id)}
              className="absolute"
              style={{ left: pos.x, top: pos.y, width: card.kind === "enable" ? 440 : CARD_W, cursor: "default" }}
            >
              {card.kind === "enable" && <EnableIntelligenceCard />}
              {card.kind === "dups" && (
                <DuplicatesCard groups={card.groups} reclaimable={card.reclaimable} onOpen={() => setOverlay("duplicates")} />
              )}
              {card.kind === "pin" && (
                <PinnedCardView
                  card={card.pin}
                  selected={selected?.path === card.pin.path}
                  verdict={lensByPath.get(card.pin.path) ? verdictForFolder(lensByPath.get(card.pin.path)!) : null}
                  onSelect={() => select({ kind: "folder", path: card.pin.path, name: card.pin.name, bytes: card.pin.bytes })}
                  onUnpin={() => unpinCard(card.pin.path)}
                />
              )}
              {card.kind === "finding" && (
                <FindingCardView
                  f={card.finding}
                  busy={busyId === card.finding.id || busyKind === card.finding.kind}
                  onConfirm={() => void act(card.finding.id, () => confirmDiscovery(indexPath!, card.finding.id))}
                  onReject={() => void act(card.finding.id, () => rejectDiscovery(indexPath!, card.finding.id))}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DuplicatesCard({ groups, reclaimable, onOpen }: { groups: number; reclaimable: number; onOpen: () => void }) {
  return (
    <div className="rounded-[11px] border border-line bg-panel p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded-[5px] bg-primary/[0.1] px-2 py-0.5 text-10 font-semibold uppercase tracking-[0.1em] text-primary-ink">
          duplicates
        </span>
        <span className="mono ml-auto text-10 text-dim">{groups} groups</span>
      </div>
      <div className="mono mb-3 text-11 text-primary-ink">↑ {formatBytes(reclaimable)} reclaimable</div>
      <button
        type="button"
        onClick={onOpen}
        className="w-full rounded-[7px] bg-primary py-1.5 text-11 font-semibold text-on-primary"
      >
        Open workbench — compare copies
      </button>
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
    <div className="rounded-[11px] border border-line bg-panel p-3.5">
      <div className="mb-3 flex items-center justify-between">
        <span className="rounded-[5px] bg-primary/[0.1] px-2 py-0.5 text-10 font-semibold uppercase tracking-[0.1em] text-primary-ink">
          finding
        </span>
        <span className="mono text-10 text-dim">{(f.confidence * 100).toFixed(0)}% confident</span>
      </div>

      <PathChip path={f.subject} accent />
      <div className="my-1.5 flex items-center gap-2 pl-3 text-10 text-label">
        <span className="text-primary-ink">↓</span>
        <span className="italic">{f.predicate}</span>
      </div>
      <PathChip path={f.object} />

      <div className="mono mt-3 text-11 text-primary-ink">↑ {formatBytes(f.bytes)} reclaimable if confirmed</div>

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
      className="cursor-pointer rounded-[11px] border bg-panel p-3.5"
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
