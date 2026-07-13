import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Expand,
  Eye,
  EyeOff,
  File,
  Folder,
  Link2,
  Loader2,
  Minus,
  Move,
  Network,
  Orbit,
  Pencil,
  PinOff,
  Play,
  Plus,
  Sparkles,
  StickyNote,
  TriangleAlert,
  X,
} from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import {
  confirmDiscovery,
  confirmDiscoveryPattern,
  listDiscoveries,
  rejectDiscovery,
  rejectDiscoveryPattern,
  type NativeDiscovery,
} from "@bridge/nativeClient";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { useScanController } from "../../state/scanController";
import { FINDING_KINDS, baseName, parseFinding, type Finding } from "../../lib/discoveries";
import { squarify } from "../../lib/squarify";
import { categoryOf } from "../../lib/categories";
import { canStage, verdictForFolder } from "../../lib/verdict";
import { Button, IconButton } from "../ui/Button";
import { EmptyState } from "../ui/Card";
import { Kbd, VerdictTag, Tag } from "../ui/Chip";
import { EnableIntelligenceCard } from "../EnableIntelligenceCard";
import { ViewHeader } from "./ViewHeader";
import type { PinnedCard } from "../../state/types";

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

type Pos = { x: number; y: number };

type NoteModel = { id: string; text: string };

type SourceCardModel = {
  id: string;
  kind: "source";
  /** the shared origin path this cluster of findings depends on */
  path: string;
  count: number;
  /** total bytes freed if every finding in the cluster is confirmed */
  bytes: number;
  findingIds: number[];
};

type CardModel =
  | { id: string; kind: "enable" }
  | { id: string; kind: "finding"; finding: Finding }
  | {
      id: string;
      kind: "dup";
      groupId: number;
      size: number;
      copies: number;
      waste: number;
      confidence: number;
      /** copy paths, when the overview summary carries them (it may not — see edges) */
      paths: string[];
    }
  | { id: string; kind: "pin"; pin: PinnedCard }
  | { id: string; kind: "note"; note: NoteModel }
  | SourceCardModel;

const CARD_W = 300;
/** Estimated heights per kind — used for packing, edges, minimap and fit. */
const CARD_H: Record<CardModel["kind"], number> = {
  enable: 200,
  finding: 200,
  dup: 168,
  pin: 216,
  note: 150,
  source: 148,
};
const CELL_W = 340;
const CELL_H = 270;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2;

const posKey = (indexPath: string) => `be.board2.pos:${indexPath}`;
const noteKey = (indexPath: string) => `be.board2.notes:${indexPath}`;
const editsKey = (indexPath: string) => `be.board2.edits:${indexPath}`;

/** A user-drawn edge between any two cards. */
type UserEdge = { id: string; from: string; to: string; label: string };

/**
 * The user's own concepts layered OVER the generated intelligence: rename or
 * hide any derived card, relabel or delete derived edges, draw new edges.
 * Same per-index localStorage overlay pattern as positions and notes.
 */
type BoardEdits = {
  overrides: Record<string, { label?: string; hidden?: boolean }>;
  edges: UserEdge[];
  removedEdges: string[];
  edgeLabels: Record<string, string>;
};
const EMPTY_EDITS: BoardEdits = { overrides: {}, edges: [], removedEdges: [], edgeLabels: {} };

function loadJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function BoardView() {
  const {
    ontologyEnabled,
    indexPath,
    pinned,
    unpinCard,
    select,
    selected,
    toggleStaged,
    isStaged,
    overlay,
    review,
  } = useWorkspace();
  const { lensByPath, dataVersion, overview, ontology, activeEntry, tree } = useIndexData();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  /* ---- findings data ---- */
  const load = useCallback(async () => {
    if (!indexPath || !ontologyEnabled) {
      setFindings([]);
      return;
    }
    const id = ++reqId.current;
    setError(null);
    try {
      const lists = await Promise.all(
        FINDING_KINDS.map((k) => listDiscoveries(indexPath, k, 60).catch(() => [] as NativeDiscovery[]))
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
    }
    // dataVersion: refetch after refreshData so findings track enrichment progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexPath, ontologyEnabled, dataVersion]);

  useEffect(() => {
    void load();
  }, [load]);

  const { view: jobView, enqueue } = useScanController();
  const jobActive = jobView.status === "scanning";
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [jobActive, load]);

  /* ---- notes ---- */
  const [notes, setNotes] = useState<NoteModel[]>(() => (indexPath ? loadJson(noteKey(indexPath), []) : []));
  useEffect(() => {
    setNotes(indexPath ? loadJson(noteKey(indexPath), []) : []);
  }, [indexPath]);
  const saveNotes = useCallback(
    (next: NoteModel[]) => {
      setNotes(next);
      if (indexPath) localStorage.setItem(noteKey(indexPath), JSON.stringify(next));
    },
    [indexPath]
  );

  /* ---- user edits: renames, hidden cards, own edges ---- */
  const [edits, setEdits] = useState<BoardEdits>(() =>
    indexPath ? { ...EMPTY_EDITS, ...loadJson(editsKey(indexPath), EMPTY_EDITS) } : EMPTY_EDITS
  );
  useEffect(() => {
    setEdits(indexPath ? { ...EMPTY_EDITS, ...loadJson(editsKey(indexPath), EMPTY_EDITS) } : EMPTY_EDITS);
  }, [indexPath]);
  const saveEdits = useCallback(
    (update: (prev: BoardEdits) => BoardEdits) =>
      setEdits((prev) => {
        const next = update(prev);
        if (indexPath) localStorage.setItem(editsKey(indexPath), JSON.stringify(next));
        return next;
      }),
    [indexPath]
  );
  /** Card the connect gesture started from; the next card clicked completes the edge. */
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  /** Edge whose label is being edited inline, by edge key. */
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  /** Card being renamed inline. */
  const [editingCard, setEditingCard] = useState<string | null>(null);

  const renameCard = useCallback(
    (id: string, label: string) =>
      saveEdits((prev) => ({
        ...prev,
        overrides: { ...prev.overrides, [id]: { ...prev.overrides[id], label: label.trim() || undefined } },
      })),
    [saveEdits]
  );
  const hideCard = useCallback(
    (id: string) =>
      saveEdits((prev) => ({
        ...prev,
        overrides: { ...prev.overrides, [id]: { ...prev.overrides[id], hidden: true } },
      })),
    [saveEdits]
  );
  const completeLink = useCallback(
    (id: string) => {
      setLinkFrom((from) => {
        if (!from) return id;
        if (from !== id) {
          const edgeId = `uedge:${Date.now()}`;
          saveEdits((prev) => ({
            ...prev,
            edges: [...prev.edges, { id: edgeId, from, to: id, label: "relates to" }],
          }));
          setEditingEdge(edgeId); // name the relationship right away
        }
        return null;
      });
    },
    [saveEdits]
  );
  const commitEdgeLabel = useCallback(
    (edge: { key: string; user?: boolean }, label: string) => {
      const text = label.trim();
      if (edge.user) {
        saveEdits((prev) => ({
          ...prev,
          edges: prev.edges.map((e) => (e.id === edge.key ? { ...e, label: text || e.label } : e)),
        }));
      } else if (text) {
        saveEdits((prev) => ({ ...prev, edgeLabels: { ...prev.edgeLabels, [edge.key]: text } }));
      }
      setEditingEdge(null);
    },
    [saveEdits]
  );
  const deleteEdge = useCallback(
    (edge: { key: string; user?: boolean }) => {
      if (edge.user) {
        saveEdits((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== edge.key) }));
      } else {
        saveEdits((prev) => ({ ...prev, removedEdges: [...prev.removedEdges, edge.key] }));
      }
      setEditingEdge(null);
    },
    [saveEdits]
  );

  /* ---- card models (content-keyed, order-independent) ---- */
  const dupGroups = overview?.duplicate_groups ?? [];
  const allCards = useMemo<CardModel[]>(() => {
    const out: CardModel[] = [];
    if (!ontologyEnabled) out.push({ id: "enable", kind: "enable" });
    for (const pin of pinned) out.push({ id: `pin:${pin.path}`, kind: "pin", pin });
    for (const f of findings) out.push({ id: `find:${f.id}`, kind: "finding", finding: f });
    // Cluster findings by their shared source: every origin that two or more
    // findings depend on gets a hub card the finding cards connect to.
    const bySource = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = bySource.get(f.object);
      if (list) list.push(f);
      else bySource.set(f.object, [f]);
    }
    for (const [path, list] of bySource) {
      if (list.length < 2) continue;
      out.push({
        id: `source:${path}`,
        kind: "source",
        path,
        count: list.length,
        bytes: list.reduce((s, f) => s + f.bytes, 0),
        findingIds: list.map((f) => f.id),
      });
    }
    for (const g of dupGroups.slice(0, 6)) {
      out.push({
        id: `dup:${g.id}`,
        kind: "dup",
        groupId: g.id,
        size: g.size,
        copies: g.file_count,
        waste: g.reclaimable_bytes,
        confidence: g.confidence,
        // Member sample paths ride along on the summary (largest first), so
        // dup↔finding edges draw without any per-group fetch.
        paths: g.sample_paths ?? [],
      });
    }
    for (const n of notes) out.push({ id: n.id, kind: "note", note: n });
    return out;
  }, [ontologyEnabled, dupGroups, pinned, findings, notes]);

  const hiddenCount = useMemo(
    () => allCards.filter((c) => edits.overrides[c.id]?.hidden).length,
    [allCards, edits]
  );
  const cards = useMemo(
    () => allCards.filter((c) => !edits.overrides[c.id]?.hidden),
    [allCards, edits]
  );

  /* ---- spatial state ---- */
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ w: 800, h: 600 });
  const [pan, setPan] = useState<Pos>({ x: 24, y: 24 });
  const [zoom, setZoom] = useState(1);
  const [positions, setPositions] = useState<Record<string, Pos>>(() =>
    indexPath ? loadJson(posKey(indexPath), {}) : {}
  );
  /** Bumped by Auto-arrange so the placement effect re-runs on a cleared board. */
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [dragging, setDragging] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  /** Multi-selection: marquee (Shift+drag), Shift+click toggle, hull-label grab. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(
    null
  );
  const drag = useRef<
    | { mode: "pan"; startX: number; startY: number; panX: number; panY: number; moved: boolean }
    | { mode: "cards"; ids: string[]; offsets: Map<string, { offX: number; offY: number }> }
    | { mode: "marquee"; add: boolean }
    | null
  >(null);

  useEffect(() => {
    setPositions(indexPath ? loadJson(posKey(indexPath), {}) : {});
  }, [indexPath]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const obs = new ResizeObserver(([entry]) =>
      setViewport({ w: entry.contentRect.width, h: entry.contentRect.height })
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const persistPositions = useCallback(
    (next: Record<string, Pos>, ids: Set<string>) => {
      if (!indexPath) return;
      // Prune entries for cards that no longer exist so stale slots free up.
      const pruned = Object.fromEntries(Object.entries(next).filter(([id]) => ids.has(id)));
      localStorage.setItem(posKey(indexPath), JSON.stringify(pruned));
    },
    [indexPath]
  );

  /**
   * Stable placement: every card gets a position the first time it appears and
   * KEEPS it across refetches — that is what makes the board spatial instead of
   * a reshuffling grid. Fresh cards land as a CONSTELLATION, not a grid fill:
   * each source hub sits at the center of a ring of its findings, leftover
   * findings form organic blobs by parent folder, duplicate groups their own
   * blob — and whole groups are packed on a loose spiral with clear water
   * between them, so the board reads as a node graph you traverse, not rows.
   * Cards that already have a saved position are never moved.
   */
  useEffect(() => {
    setPositions((prev) => {
      const missing = cards.filter((c) => !prev[c.id]);
      if (!missing.length) return prev;
      const occupied = new Set(
        Object.values(prev).map((p) => `${Math.round(p.x / CELL_W)}:${Math.round(p.y / CELL_H)}`)
      );
      const next = { ...prev };

      /* deterministic pseudo-randomness — stable across reloads. Auto-arrange
         bumps layoutEpoch, which re-seeds every angle so each press produces a
         visibly different (but equally tidy) arrangement. */
      const salt = layoutEpoch ? `#${layoutEpoch}` : "";
      const hash32 = (s: string) => {
        const input = s + salt;
        let h = 0;
        for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
        return h >>> 0;
      };
      const jitter = (id: string, spread = 36) => ({
        jx: (hash32(id) % spread) - spread / 2,
        jy: (hash32(`${id}~y`) % spread) - spread / 2,
      });

      /* --- cell helpers, used only to tuck late cards beside their cluster --- */
      const cellFree = (cx: number, cy: number) => !occupied.has(`${cx}:${cy}`);
      const put = (id: string, cx: number, cy: number) => {
        occupied.add(`${cx}:${cy}`);
        next[id] = { x: cx * CELL_W + 16, y: cy * CELL_H + 16 };
      };
      const nearestFree = (cx: number, cy: number) => {
        if (cellFree(cx, cy)) return { cx, cy };
        for (let r = 1; r <= 64; r++) {
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              if (cellFree(cx + dx, cy + dy)) return { cx: cx + dx, cy: cy + dy };
            }
        }
        return { cx: cx + 65, cy };
      };
      const cellOf = (pos: Pos) => ({
        cx: Math.round((pos.x - 16) / CELL_W),
        cy: Math.round((pos.y - 16) / CELL_H),
      });

      const missingIds = new Set(missing.map((c) => c.id));
      const handled = new Set<string>();

      /* 1 — clusters that already live on the board: tuck new cards beside them. */
      const sourceCards = cards
        .filter((c): c is SourceCardModel => c.kind === "source")
        .sort((a, b) => b.count - a.count);
      const freshClusters: Array<{ hub: SourceCardModel; memberIds: string[] }> = [];
      for (const hub of sourceCards) {
        const memberIds = hub.findingIds.map((n) => `find:${n}`).filter((id) => missingIds.has(id));
        const hubMissing = missingIds.has(hub.id);
        if (!hubMissing && !memberIds.length) continue;
        const anchorPos = !hubMissing
          ? next[hub.id]
          : hub.findingIds.map((n) => next[`find:${n}`]).find(Boolean);
        if (anchorPos) {
          const origin = cellOf(anchorPos);
          for (const id of hubMissing ? [hub.id, ...memberIds] : memberIds) {
            const { cx, cy } = nearestFree(origin.cx, origin.cy);
            put(id, cx, cy);
            handled.add(id);
          }
          continue;
        }
        freshClusters.push({ hub, memberIds });
        handled.add(hub.id);
        memberIds.forEach((id) => handled.add(id));
      }

      /* 2 — build constellation groups in local coordinates. */
      type Placed = { id: string; lx: number; ly: number };
      type Group = { key: string; place: Placed[]; radius: number };
      const groups: Group[] = [];

      for (const { hub, memberIds } of freshClusters) {
        const place: Placed[] = [{ id: hub.id, lx: -CARD_W / 2, ly: -CARD_H.source / 2 }];
        let r = 440;
        let ring = 0;
        const remaining = [...memberIds];
        while (remaining.length) {
          const capacity = Math.max(4, Math.floor((2 * Math.PI * r) / 440));
          const batch = remaining.splice(0, capacity);
          const offset = (hash32(hub.id) % 628) / 100 + ring * 0.45;
          batch.forEach((id, i) => {
            const angle = offset + (2 * Math.PI * i) / batch.length;
            const { jx, jy } = jitter(id);
            place.push({
              id,
              lx: Math.cos(angle) * r * 1.12 + jx - CARD_W / 2,
              ly: Math.sin(angle) * r * 0.8 + jy - CARD_H.finding / 2,
            });
          });
          r += 400;
          ring++;
        }
        groups.push({ key: hub.id, place, radius: (r - 400) * 1.12 + 460 });
      }

      /** Organic blob (sunflower spiral) for hubless card sets. */
      const blob = (key: string, items: Array<{ id: string; kind: CardModel["kind"] }>) => {
        if (!items.length) return;
        const seed = (hash32(key) % 628) / 100;
        const place = items.map((item, i) => {
          const r = 330 * Math.sqrt(i + 0.4);
          const angle = i * 2.399963 + seed;
          const { jx, jy } = jitter(item.id, 36);
          return {
            id: item.id,
            lx: Math.cos(angle) * r * 1.5 + jx - CARD_W / 2,
            ly: Math.sin(angle) * r * 0.95 + jy - CARD_H[item.kind] / 2,
          };
        });
        groups.push({ key, place, radius: 330 * Math.sqrt(items.length + 0.4) * 1.5 + 420 });
      };

      // Leftover findings blob together by parent folder; tiny groups pool up.
      const parentOf = (p: string) => {
        const cut = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
        return cut > 0 ? p.slice(0, cut) : p;
      };
      const rest = missing.filter((c) => !handled.has(c.id));
      const byFolder = new Map<string, Array<{ id: string; kind: CardModel["kind"] }>>();
      const pooled: Array<{ id: string; kind: CardModel["kind"] }> = [];
      const restFindings = rest.filter(
        (c): c is Extract<CardModel, { kind: "finding" }> => c.kind === "finding"
      );
      for (const card of restFindings) {
        const key = parentOf(card.finding.subject);
        const list = byFolder.get(key);
        if (list) list.push({ id: card.id, kind: card.kind });
        else byFolder.set(key, [{ id: card.id, kind: card.kind }]);
      }
      for (const [key, list] of byFolder) {
        if (list.length >= 3) blob(`folder:${key}`, list);
        else pooled.push(...list);
      }
      blob("blob:findings", pooled);
      blob("blob:dups", rest.filter((c) => c.kind === "dup").map((c) => ({ id: c.id, kind: c.kind })));
      blob(
        "blob:misc",
        rest
          .filter((c) => c.kind !== "finding" && c.kind !== "dup")
          .map((c) => ({ id: c.id, kind: c.kind }))
      );

      /* 3 — pack groups on a loose spiral around the existing content. */
      const circles: Array<{ x: number; y: number; r: number }> = [];
      const placedPositions = Object.entries(next);
      if (placedPositions.length) {
        const xs = placedPositions.map(([, p]) => p);
        const minX = Math.min(...xs.map((p) => p.x));
        const maxX = Math.max(...xs.map((p) => p.x + CARD_W));
        const minY = Math.min(...xs.map((p) => p.y));
        const maxY = Math.max(...xs.map((p) => p.y + 220));
        circles.push({
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
          r: Math.hypot(maxX - minX, maxY - minY) / 2 + 120,
        });
      }
      const origin = circles[0] ? { x: circles[0].x, y: circles[0].y } : { x: 0, y: 0 };
      groups.sort((a, b) => b.radius - a.radius);
      for (const group of groups) {
        let center = origin;
        if (!circles.length) {
          circles.push({ ...origin, r: group.radius });
        } else {
          let theta = (hash32(group.key) % 628) / 100;
          let found = false;
          for (let i = 0; i < 6000 && !found; i++) {
            theta += 0.21;
            const rr = 40 + 62 * theta;
            const x = origin.x + Math.cos(theta) * rr * 1.3;
            const y = origin.y + Math.sin(theta) * rr * 0.82;
            if (circles.every((c) => Math.hypot(x - c.x, y - c.y) >= c.r + group.radius + 280)) {
              circles.push({ x, y, r: group.radius });
              center = { x, y };
              found = true;
            }
          }
          if (!found) {
            const x = origin.x + circles.length * 1200;
            circles.push({ x, y: origin.y, r: group.radius });
            center = { x, y: origin.y };
          }
        }
        for (const { id, lx, ly } of group.place) {
          next[id] = { x: center.x + lx, y: center.y + ly };
          occupied.add(`${Math.round(next[id].x / CELL_W)}:${Math.round(next[id].y / CELL_H)}`);
        }
      }

      persistPositions(next, new Set(allCards.map((c) => c.id)));
      return next;
    });
  }, [cards, allCards, persistPositions, layoutEpoch]);

  /* ---- edges ---- */
  const edges = useMemo(() => {
    const under = (p: string, root: string) =>
      p === root || p.startsWith(root + "/") || p.startsWith(root + "\\");
    const center = (id: string, kind: CardModel["kind"]): Pos | null => {
      const pos = positions[id];
      return pos ? { x: pos.x + CARD_W / 2, y: pos.y + CARD_H[kind] / 2 } : null;
    };
    const out: Array<{ key: string; from: Pos; to: Pos; label: string; strong: boolean; user?: boolean }> = [];
    const hubs = new Set(cards.filter((c) => c.kind === "source").map((c) => (c as SourceCardModel).path));
    const findingCards = cards.filter(
      (c): c is Extract<CardModel, { kind: "finding" }> => c.kind === "finding"
    );
    for (const card of findingCards) {
      for (const pin of pinned) {
        if (under(card.finding.subject, pin.path) || under(card.finding.object, pin.path)) {
          const from = center(card.id, "finding");
          const to = center(`pin:${pin.path}`, "pin");
          if (from && to)
            out.push({
              key: `${card.id}~${pin.path}`,
              from,
              to,
              label: card.finding.predicate,
              strong: card.finding.confidence >= 0.85,
            });
        }
      }
      // Every clustered finding points at its source hub.
      if (hubs.has(card.finding.object)) {
        const from = center(card.id, "finding");
        const to = center(`source:${card.finding.object}`, "source");
        if (from && to)
          out.push({
            key: `${card.id}~source`,
            from,
            to,
            label: card.finding.predicate,
            strong: card.finding.confidence >= 0.85,
          });
      }
    }
    // Dup ↔ finding links draw from the sample paths riding on each group
    // summary — no per-group fetch from the board.
    for (const dup of cards) {
      if (dup.kind !== "dup" || !dup.paths.length) continue;
      for (const fc of findingCards) {
        const f = fc.finding;
        const hit = dup.paths.some(
          (p) => under(p, f.subject) || under(f.subject, p) || under(p, f.object) || under(f.object, p)
        );
        if (!hit) continue;
        const from = center(dup.id, "dup");
        const to = center(fc.id, "finding");
        if (from && to) out.push({ key: `${dup.id}~${fc.id}`, from, to, label: "shares files", strong: false });
      }
    }
    // User edits win over the derived graph: deleted edges disappear, relabels
    // replace the generated predicate, and user-drawn edges join the layer.
    const kept = out
      .filter((e) => !edits.removedEdges.includes(e.key))
      .map((e) => (edits.edgeLabels[e.key] ? { ...e, label: edits.edgeLabels[e.key] } : e));
    const kindOf = new Map(cards.map((c) => [c.id, c.kind]));
    for (const ue of edits.edges) {
      const fk = kindOf.get(ue.from);
      const tk = kindOf.get(ue.to);
      if (!fk || !tk) continue; // an endpoint card no longer exists (or is hidden)
      const from = center(ue.from, fk);
      const to = center(ue.to, tk);
      if (from && to) kept.push({ key: ue.id, from, to, label: ue.label, strong: true, user: true });
    }
    return kept;
  }, [cards, positions, pinned, edits]);

  /* ---- pointer interactions ---- */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // React registers wheel listeners passively; zoom needs preventDefault.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraTouched.current = true;
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom((z) => {
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.12 : 0.89)));
        setPan((p) => ({ x: cx - ((cx - p.x) * nz) / z, y: cy - ((cy - p.y) * nz) / z }));
        return nz;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** Screen point → canvas coordinates (pan/zoom corrected). */
  const toCanvas = useCallback(
    (e: { clientX: number; clientY: number }): Pos | null => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return null;
      return { x: (e.clientX - rect.left - pan.x) / zoom, y: (e.clientY - rect.top - pan.y) / zoom };
    },
    [pan, zoom]
  );

  /** Grab a set of cards for a group drag, keyed off the pointer's canvas point. */
  const beginCardsDrag = useCallback(
    (ids: string[], e: React.PointerEvent) => {
      const at = toCanvas(e);
      if (!at || !ids.length) return;
      const offsets = new Map<string, { offX: number; offY: number }>();
      for (const id of ids) {
        const pos = positions[id];
        if (pos) offsets.set(id, { offX: at.x - pos.x, offY: at.y - pos.y });
      }
      drag.current = { mode: "cards", ids: [...offsets.keys()], offsets };
      setDragging(ids[0]);
      try {
        wrapRef.current?.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort — synthetic pointers have no active id */
      }
    },
    [positions, toCanvas]
  );

  const onBackgroundDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore pointer-downs on cards, hull handles, and canvas chrome (zoom
      // controls, minimap) — starting a pan here would capture the pointer and
      // swallow the button's click.
      if ((e.target as HTMLElement).closest("[data-board-card], [data-board-hull], button")) return;
      const at = toCanvas(e);
      if (e.shiftKey && at) {
        // Shift+drag on the background lassos cards instead of panning.
        drag.current = { mode: "marquee", add: false };
        setMarquee({ x1: at.x, y1: at.y, x2: at.x, y2: at.y });
      } else {
        cameraTouched.current = true;
        drag.current = {
          mode: "pan",
          startX: e.clientX,
          startY: e.clientY,
          panX: pan.x,
          panY: pan.y,
          moved: false,
        };
        setPanning(true);
      }
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort — synthetic pointers have no active id */
      }
    },
    [pan, toCanvas]
  );

  const onCardDown = useCallback(
    (id: string) => (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("button, input, textarea, a, video, audio")) return;
      e.stopPropagation();
      if (linkFrom) {
        // Connect mode: clicking any card completes the edge instead of dragging.
        completeLink(id);
        return;
      }
      if (e.shiftKey) {
        // Shift+click toggles membership without starting a drag.
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }
      // Dragging any selected card moves the whole selection.
      const ids = selectedIds.has(id) ? [...selectedIds] : [id];
      if (!selectedIds.has(id)) setSelectedIds(new Set([id]));
      beginCardsDrag(ids, e);
    },
    [selectedIds, beginCardsDrag, linkFrom, completeLink]
  );

  /** Pointer-down on a hull label: select the whole cluster and drag it as one. */
  const onHullDown = useCallback(
    (memberIds: string[]) => (e: React.PointerEvent) => {
      e.stopPropagation();
      const ids = memberIds.filter((id) => positions[id]);
      if (!ids.length) return;
      setSelectedIds(new Set(ids));
      beginCardsDrag(ids, e);
    },
    [positions, beginCardsDrag]
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.mode === "pan") {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 3) d.moved = true;
        setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
      } else if (d.mode === "cards") {
        const at = toCanvas(e);
        if (!at) return;
        setPositions((prev) => {
          const next = { ...prev };
          for (const [id, off] of d.offsets) next[id] = { x: at.x - off.offX, y: at.y - off.offY };
          return next;
        });
      } else {
        const at = toCanvas(e);
        if (at) setMarquee((m) => (m ? { ...m, x2: at.x, y2: at.y } : m));
      }
    },
    [toCanvas]
  );

  const onUp = useCallback(() => {
    const d = drag.current;
    if (d?.mode === "cards") {
      setPositions((prev) => {
        persistPositions(prev, new Set(allCards.map((c) => c.id)));
        return prev;
      });
    } else if (d?.mode === "pan" && !d.moved) {
      // A plain background click (no drag) clears the selection.
      setSelectedIds(new Set());
    } else if (d?.mode === "marquee") {
      setMarquee((m) => {
        if (m) {
          const minX = Math.min(m.x1, m.x2);
          const maxX = Math.max(m.x1, m.x2);
          const minY = Math.min(m.y1, m.y2);
          const maxY = Math.max(m.y1, m.y2);
          const hit = cards
            .filter((c) => {
              const pos = positions[c.id];
              if (!pos) return false;
              return (
                pos.x < maxX && pos.x + CARD_W > minX && pos.y < maxY && pos.y + CARD_H[c.kind] > minY
              );
            })
            .map((c) => c.id);
          setSelectedIds((prev) => (d.add ? new Set([...prev, ...hit]) : new Set(hit)));
        }
        return null;
      });
    }
    drag.current = null;
    setDragging(null);
    setPanning(false);
  }, [persistPositions, cards, allCards, positions]);

  /* ---- selection keyboard: Esc clears · Ctrl+A selects all · arrows nudge ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (overlay || review) return; // overlays own the keyboard
      if (e.key === "Escape") {
        setMarquee(null);
        setLinkFrom(null);
        setEditingEdge(null);
        setEditingCard(null);
        setSelectedIds((prev) => (prev.size ? new Set() : prev));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedIds(new Set(cards.map((c) => c.id)));
        return;
      }
      if (selectedIds.size && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 64 : 16;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        setPositions((prev) => {
          const next = { ...prev };
          for (const id of selectedIds) {
            const pos = next[id];
            if (pos) next[id] = { x: pos.x + dx, y: pos.y + dy };
          }
          persistPositions(next, new Set(allCards.map((c) => c.id)));
          return next;
        });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cards, allCards, selectedIds, overlay, review, persistPositions]);

  /* ---- camera helpers ---- */
  const contentBounds = useCallback(() => {
    const entries = cards.map((c) => ({ pos: positions[c.id], kind: c.kind })).filter((e) => e.pos);
    if (!entries.length) return null;
    const minX = Math.min(...entries.map((e) => e.pos!.x));
    const minY = Math.min(...entries.map((e) => e.pos!.y));
    const maxX = Math.max(...entries.map((e) => e.pos!.x + CARD_W));
    const maxY = Math.max(...entries.map((e) => e.pos!.y + CARD_H[e.kind]));
    return { minX, minY, maxX, maxY };
  }, [cards, positions]);

  const fitToContent = useCallback(() => {
    const b = contentBounds();
    if (!b) return;
    const bw = b.maxX - b.minX + 64;
    const bh = b.maxY - b.minY + 64;
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(viewport.w / bw, viewport.h / bh, 1)));
    setZoom(nz);
    setPan({
      x: (viewport.w - (b.maxX + b.minX) * nz) / 2,
      y: (viewport.h - (b.maxY + b.minY) * nz) / 2,
    });
  }, [contentBounds, viewport]);

  // Auto-fit the camera while the user hasn't touched it — cards stream in
  // asynchronously (findings, dups), and pan/zoom aren't persisted, so a fresh
  // mount keeps showing the whole board until the first deliberate pan/zoom.
  const cameraTouched = useRef(false);
  useEffect(() => {
    cameraTouched.current = false;
  }, [indexPath]);
  useEffect(() => {
    if (cameraTouched.current || !indexPath) return;
    if (!cards.length || !cards.every((c) => positions[c.id])) return;
    if (viewport.w <= 0) return;
    fitToContent();
  }, [indexPath, cards, positions, viewport.w, fitToContent]);

  const zoomBy = useCallback(
    (factor: number) => {
      cameraTouched.current = true;
      const cx = viewport.w / 2;
      const cy = viewport.h / 2;
      setZoom((z) => {
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
        setPan((p) => ({ x: cx - ((cx - p.x) * nz) / z, y: cy - ((cy - p.y) * nz) / z }));
        return nz;
      });
    },
    [viewport]
  );

  /* ---- actions ---- */
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

  const addNote = useCallback(() => {
    const id = `note:${Date.now()}`;
    saveNotes([...notes, { id, text: "" }]);
  }, [notes, saveNotes]);

  const stageFinding = useCallback(
    (f: Finding) => {
      const row = lensByPath.get(f.subject);
      const verdict = row ? verdictForFolder(row) : "review";
      if (!canStage(verdict, f.bytes)) return;
      toggleStaged({
        path: f.subject,
        name: baseName(f.subject),
        bytes: f.bytes,
        reason: f.predicate,
        verdict,
        kind: "folder",
      });
    },
    [lensByPath, toggleStaged]
  );

  /* ---- enrichment chips ---- */
  const liveEnrich = jobActive && jobView.message.startsWith("Enrichment") ? jobView : null;
  const interrupted =
    !jobActive &&
    (ontology?.populators?.some((p) => p.status === "running" || p.status === "paused") ?? false);
  const failed = ontology?.populators?.filter((p) => p.status === "failed") ?? [];
  const resumeEnrichment = () => {
    if (!activeEntry?.root_path) return;
    enqueue(activeEntry.root_path, "smart");
  };

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    return counts;
  }, [findings]);

  const pendingBytes = findings.reduce((s, f) => s + f.bytes, 0);
  const sourceCount = useMemo(() => cards.filter((c) => c.kind === "source").length, [cards]);

  const confirmCluster = useCallback(
    (hub: SourceCardModel) =>
      void actKind(hub.id, async () => {
        for (const id of hub.findingIds) await confirmDiscovery(indexPath!, id);
        return hub.findingIds.length;
      }),
    [actKind, indexPath]
  );

  /* ---- cluster hulls: soft group outlines behind the cards ---- */
  const hulls = useMemo(() => {
    const out: Array<{
      key: string;
      label: string;
      tint: string;
      x: number;
      y: number;
      w: number;
      h: number;
      memberIds: string[];
    }> = [];
    const addHull = (key: string, label: string, tint: string, ids: string[]) => {
      const members = ids
        .map((id) => ({ pos: positions[id], kind: cards.find((c) => c.id === id)?.kind }))
        .filter((m): m is { pos: Pos; kind: CardModel["kind"] } => Boolean(m.pos && m.kind));
      if (members.length < 2) return;
      const minX = Math.min(...members.map((m) => m.pos.x)) - 34;
      const minY = Math.min(...members.map((m) => m.pos.y)) - 40;
      const maxX = Math.max(...members.map((m) => m.pos.x + CARD_W)) + 34;
      const maxY = Math.max(...members.map((m) => m.pos.y + CARD_H[m.kind])) + 30;
      out.push({ key, label, tint, x: minX, y: minY, w: maxX - minX, h: maxY - minY, memberIds: ids });
    };
    for (const card of cards) {
      if (card.kind === "source") {
        addHull(
          `hull:${card.id}`,
          baseName(card.path),
          "var(--color-primary)",
          [card.id, ...card.findingIds.map((n) => `find:${n}`)]
        );
      }
    }
    addHull(
      "hull:dups",
      "Duplicate groups",
      "var(--color-danger)",
      cards.filter((c) => c.kind === "dup").map((c) => c.id)
    );
    return out;
  }, [cards, positions]);

  /** Wipe saved positions and let the constellation layout re-place everything. */
  const autoArrange = useCallback(() => {
    if (!indexPath) return;
    cameraTouched.current = false;
    localStorage.removeItem(posKey(indexPath));
    setPositions({});
    setLayoutEpoch((epoch) => epoch + 1);
  }, [indexPath]);

  /* ---- minimap ---- */
  const minimap = useMemo(() => {
    const entries = cards.map((c) => ({ pos: positions[c.id], kind: c.kind, id: c.id })).filter((e) => e.pos);
    if (!entries.length) return null;
    const minX = Math.min(...entries.map((e) => e.pos!.x));
    const minY = Math.min(...entries.map((e) => e.pos!.y));
    const maxX = Math.max(...entries.map((e) => e.pos!.x + CARD_W));
    const maxY = Math.max(...entries.map((e) => e.pos!.y + CARD_H[e.kind]));
    const MW = 132;
    const MH = 88;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const s = Math.min(MW / bw, MH / bh) * 0.9;
    const ox = (MW - bw * s) / 2 - minX * s;
    const oy = (MH - bh * s) / 2 - minY * s;
    const rects = entries.map((e) => ({
      id: e.id,
      x: e.pos!.x * s + ox,
      y: e.pos!.y * s + oy,
      w: CARD_W * s,
      h: CARD_H[e.kind] * s,
      color:
        e.kind === "finding"
          ? "var(--color-primary)"
          : e.kind === "source"
            ? "var(--color-cat-archive)"
            : e.kind === "dup"
              ? "var(--color-danger)"
              : e.kind === "pin"
                ? "var(--color-history)"
                : "var(--color-line-strong)",
    }));
    const view = {
      x: (-pan.x / zoom) * s + ox,
      y: (-pan.y / zoom) * s + oy,
      w: (viewport.w / zoom) * s,
      h: (viewport.h / zoom) * s,
    };
    return { MW, MH, rects, view, s, ox, oy };
  }, [cards, positions, pan, zoom, viewport]);

  const onMinimapDown = useCallback(
    (e: React.PointerEvent) => {
      if (!minimap) return;
      cameraTouched.current = true;
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Center the viewport on the clicked canvas point.
      const canvasX = (mx - minimap.ox) / minimap.s;
      const canvasY = (my - minimap.oy) / minimap.s;
      setPan({ x: viewport.w / 2 - canvasX * zoom, y: viewport.h / 2 - canvasY * zoom });
    },
    [minimap, viewport, zoom]
  );

  const empty = cards.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Board"
        sub={
          findings.length
            ? `${findings.length} findings${sourceCount ? ` · ${sourceCount} shared source${sourceCount > 1 ? "s" : ""}` : ""} · ${formatBytes(pendingBytes)} if confirmed`
            : "pin folders, confirm findings, keep your reasoning"
        }
        actions={
          <>
            {liveEnrich ? (
              <span className="mono flex items-center gap-2 rounded-full border border-primary-edge bg-primary-wash px-2.5 py-1 text-10 text-primary-ink">
                <Loader2 size={11} className="animate-spin" aria-hidden />
                {liveEnrich.message}
              </span>
            ) : interrupted ? (
              <button
                type="button"
                onClick={resumeEnrichment}
                className="flex items-center gap-1.5 rounded-full border border-protected-bd bg-protected-bg px-2.5 py-1 text-10 text-protected-tx transition-[filter] hover:brightness-125"
              >
                <Play size={10} aria-hidden /> Enrichment interrupted — resume
              </button>
            ) : null}
            {failed.length > 0 ? (
              <span
                className="flex items-center gap-1.5 rounded-full border border-danger/40 px-2.5 py-1 text-10 text-danger"
                title={failed.map((p) => `${p.name}: ${p.last_error ?? "failed"}`).join("\n")}
              >
                <TriangleAlert size={10} aria-hidden /> {failed.length} populator{failed.length > 1 ? "s" : ""} failed
              </span>
            ) : null}
            {(Array.from(kindCounts.entries()) as Array<[string, number]>)
              .filter(([, n]) => n >= 2)
              .map(([kind]) => (
                <span key={kind} className="flex gap-1">
                  <Button
                    size="sm"
                    variant="subtle"
                    className="whitespace-nowrap"
                    disabled={busyKind === kind}
                    onClick={() => void actKind(kind, () => confirmDiscoveryPattern(indexPath!, kind))}
                  >
                    <Check size={11} aria-hidden /> Confirm all {kind === "backupOf-pair" ? "backups" : "derived"}
                  </Button>
                  <Button
                    size="sm"
                    className="whitespace-nowrap"
                    disabled={busyKind === kind}
                    onClick={() => void actKind(kind, () => rejectDiscoveryPattern(indexPath!, kind))}
                  >
                    Dismiss all
                  </Button>
                </span>
              ))}
            {hiddenCount > 0 ? (
              <Button
                size="sm"
                icon={Eye}
                title="Restore the cards you hid"
                onClick={() =>
                  saveEdits((prev) => ({
                    ...prev,
                    overrides: Object.fromEntries(
                      Object.entries(prev.overrides).map(([k, v]) => [k, { ...v, hidden: false }])
                    ),
                  }))
                }
              >
                Show {hiddenCount} hidden
              </Button>
            ) : null}
            <Button size="sm" icon={StickyNote} onClick={addNote}>
              Note
            </Button>
          </>
        }
      />

      <div
        ref={wrapRef}
        className={`be-canvas relative min-h-0 flex-1 overflow-hidden ${panning ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {error ? (
          <div className="absolute top-3 left-3 z-20 rounded-lg border border-danger/40 bg-overlay px-3 py-1.5 text-11 text-danger">
            {error}
          </div>
        ) : null}

        {empty ? (
          <EmptyState
            icon={Network}
            title="An open canvas for your investigation"
            hint="Pin folders from the Inspector, add notes, and confirm the findings the intelligence layer surfaces — cards keep their place."
            action={{ label: "Add a note", icon: StickyNote, onClick: addNote }}
            className="h-full"
          />
        ) : (
          <div
            className="absolute top-0 left-0"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
          >
            {/* Cluster hulls — soft group regions behind everything. The label
                chip is a grab handle: pointer-down selects and drags the whole
                cluster as one. */}
            {hulls.map((hull) => (
              <div
                key={hull.key}
                className="pointer-events-none absolute rounded-[34px] border"
                style={{
                  left: hull.x,
                  top: hull.y,
                  width: hull.w,
                  height: hull.h,
                  background: `color-mix(in srgb, ${hull.tint} 6%, transparent)`,
                  borderColor: `color-mix(in srgb, ${hull.tint} 22%, var(--color-line))`,
                }}
              >
                <button
                  type="button"
                  data-board-hull
                  title={`Drag to move this whole group (${hull.memberIds.length} cards)`}
                  onPointerDown={onHullDown(hull.memberIds)}
                  className="mono pointer-events-auto absolute top-2 left-4 flex cursor-grab items-center gap-1.5 rounded-full border border-transparent px-2 py-1 text-9 font-semibold tracking-[0.14em] uppercase transition-colors hover:border-line-modal hover:bg-overlay"
                  style={{ color: `color-mix(in srgb, ${hull.tint} 55%, var(--color-label))` }}
                >
                  <Move size={9} strokeWidth={2.2} aria-hidden />
                  {hull.label}
                </button>
              </div>
            ))}

            {/* Marquee (Shift+drag) */}
            {marquee ? (
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-md border border-history/60"
                style={{
                  left: Math.min(marquee.x1, marquee.x2),
                  top: Math.min(marquee.y1, marquee.y2),
                  width: Math.abs(marquee.x2 - marquee.x1),
                  height: Math.abs(marquee.y2 - marquee.y1),
                  background: "color-mix(in srgb, var(--color-history) 10%, transparent)",
                }}
              />
            ) : null}

            {/* Edge layer */}
            <svg className="pointer-events-none absolute overflow-visible" width={1} height={1} aria-hidden>
              <defs>
                <marker
                  id="be-arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L8,4 L0,8 z" fill="var(--color-primary-ink)" opacity="0.75" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const mx = (edge.from.x + edge.to.x) / 2;
                const my = (edge.from.y + edge.to.y) / 2;
                const dx = edge.to.x - edge.from.x;
                const dy = edge.to.y - edge.from.y;
                const norm = Math.max(1, Math.hypot(dx, dy));
                const cx = mx - (dy / norm) * 36;
                const cy = my + (dx / norm) * 36;
                return (
                  <g key={edge.key}>
                    <path
                      d={`M${edge.from.x},${edge.from.y} Q${cx},${cy} ${edge.to.x},${edge.to.y}`}
                      fill="none"
                      stroke={edge.strong ? "var(--color-primary-edge)" : "var(--color-line-strong)"}
                      strokeWidth={1.5}
                      strokeDasharray={edge.strong ? undefined : "5 5"}
                      markerEnd="url(#be-arrow)"
                    />
                    <foreignObject
                      x={(edge.from.x + 2 * cx + edge.to.x) / 4 - (editingEdge === edge.key ? 90 : 48)}
                      y={(edge.from.y + 2 * cy + edge.to.y) / 4 - (editingEdge === edge.key ? 13 : 10)}
                      width={editingEdge === edge.key ? 180 : 96}
                      height={editingEdge === edge.key ? 26 : 20}
                    >
                      {editingEdge === edge.key ? (
                        <div
                          className="flex items-center justify-center gap-1"
                          style={{ pointerEvents: "auto" }}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <input
                            autoFocus
                            defaultValue={edge.label}
                            aria-label="Edge label"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdgeLabel(edge, e.currentTarget.value);
                              if (e.key === "Escape") setEditingEdge(null);
                            }}
                            onBlur={(e) => commitEdgeLabel(edge, e.target.value)}
                            className="mono w-[128px] rounded-full border border-primary-edge bg-overlay px-2 text-[9px] leading-[20px] text-ink outline-none"
                          />
                          <button
                            type="button"
                            title="Delete this connection"
                            // fires before the input's blur commits
                            onPointerDown={(e) => {
                              e.preventDefault();
                              deleteEdge(edge);
                            }}
                            className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-danger/40 bg-overlay text-danger"
                          >
                            <X size={10} aria-hidden />
                          </button>
                        </div>
                      ) : (
                        <div className="mono flex justify-center">
                          <button
                            type="button"
                            title="Click to rename or delete this connection"
                            style={{ pointerEvents: "auto" }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setEditingEdge(edge.key)}
                            className={`rounded-full border px-1.5 text-[8.5px] leading-[14px] whitespace-nowrap transition-colors hover:text-ink ${
                              edge.user
                                ? "border-history/50 bg-overlay text-history"
                                : "border-line-modal bg-overlay text-faint"
                            }`}
                          >
                            {edge.label}
                          </button>
                        </div>
                      )}
                    </foreignObject>
                  </g>
                );
              })}
            </svg>

            {/* Cards */}
            {cards.map((card) => {
              const pos = positions[card.id];
              if (!pos) return null;
              const inSelection = selectedIds.has(card.id);
              const groupDragging = dragging !== null && inSelection;
              return (
                <div
                  key={card.id}
                  data-board-card
                  onPointerDown={onCardDown(card.id)}
                  className="group absolute rounded-xl"
                  style={{
                    left: pos.x,
                    top: pos.y,
                    width: CARD_W,
                    zIndex: dragging === card.id ? 20 : groupDragging ? 19 : 2,
                    cursor: linkFrom ? "crosshair" : groupDragging ? "grabbing" : "grab",
                    boxShadow:
                      linkFrom === card.id
                        ? "0 0 0 2px var(--color-primary), 0 0 18px color-mix(in srgb, var(--color-primary) 30%, transparent)"
                        : inSelection
                          ? "0 0 0 2px var(--color-history), 0 0 18px color-mix(in srgb, var(--color-history) 25%, transparent)"
                          : undefined,
                  }}
                >
                  {/* Edit controls — connect, rename, hide. Visible on hover. */}
                  {card.kind !== "enable" ? (
                    <div
                      className={`absolute -top-2.5 -right-2.5 z-30 gap-1 ${
                        linkFrom === card.id ? "flex" : "hidden group-hover:flex"
                      }`}
                    >
                      <button
                        type="button"
                        title={
                          linkFrom === card.id
                            ? "Cancel connecting (Esc)"
                            : linkFrom
                              ? "Connect to this card"
                              : "Connect to another card"
                        }
                        onClick={() => completeLink(card.id)}
                        className={`flex h-6 w-6 items-center justify-center rounded-full border shadow-[0_2px_8px_rgba(0,0,0,0.4)] transition-colors ${
                          linkFrom === card.id
                            ? "border-primary bg-primary text-on-primary"
                            : "border-line-modal bg-overlay text-faint hover:text-ink"
                        }`}
                      >
                        <Link2 size={11} aria-hidden />
                      </button>
                      <button
                        type="button"
                        title="Rename — your name replaces the generated one"
                        onClick={() => setEditingCard(card.id)}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-line-modal bg-overlay text-faint shadow-[0_2px_8px_rgba(0,0,0,0.4)] transition-colors hover:text-ink"
                      >
                        <Pencil size={11} aria-hidden />
                      </button>
                      {card.kind !== "note" ? (
                        <button
                          type="button"
                          title="Hide this card from the board"
                          onClick={() => hideCard(card.id)}
                          className="flex h-6 w-6 items-center justify-center rounded-full border border-line-modal bg-overlay text-faint shadow-[0_2px_8px_rgba(0,0,0,0.4)] transition-colors hover:text-ink"
                        >
                          <EyeOff size={11} aria-hidden />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {editingCard === card.id ? (
                    <div
                      className="absolute -top-9 left-0 z-30 w-full"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <input
                        autoFocus
                        defaultValue={edits.overrides[card.id]?.label ?? ""}
                        placeholder="Name this card — empty restores the generated name"
                        aria-label="Card name"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            renameCard(card.id, e.currentTarget.value);
                            setEditingCard(null);
                          }
                          if (e.key === "Escape") setEditingCard(null);
                        }}
                        onBlur={(e) => {
                          renameCard(card.id, e.target.value);
                          setEditingCard(null);
                        }}
                        className="w-full rounded-md border border-primary-edge bg-overlay px-2 py-1 text-11 text-ink shadow-[0_8px_30px_rgba(0,0,0,0.5)] outline-none placeholder:text-dim"
                      />
                    </div>
                  ) : null}
                  <BoardCard
                    card={card}
                    overrideLabel={edits.overrides[card.id]?.label}
                    busyId={busyId}
                    busyKind={busyKind}
                    onConfirmCluster={confirmCluster}
                    selectedPath={selected?.path ?? null}
                    isStaged={isStaged}
                    onSelect={select}
                    onUnpin={unpinCard}
                    onStageFinding={stageFinding}
                    onConfirm={(f) => void act(f.id, () => confirmDiscovery(indexPath!, f.id))}
                    onDismiss={(f) => void act(f.id, () => rejectDiscovery(indexPath!, f.id))}
                    onNoteChange={(id, text) => saveNotes(notes.map((n) => (n.id === id ? { ...n, text } : n)))}
                    onNoteDelete={(id) => saveNotes(notes.filter((n) => n.id !== id))}
                    tree={tree}
                    overviewFolderMedia={overview?.folder_media ?? []}
                    lensByPath={lensByPath}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Zoom controls */}
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-1 rounded-lg border border-line-modal bg-overlay p-1">
          <IconButton icon={Minus} label="Zoom out" size={13} onClick={() => zoomBy(0.85)} />
          <span className="mono w-10 text-center text-10 text-faint">{Math.round(zoom * 100)}%</span>
          <IconButton icon={Plus} label="Zoom in" size={13} onClick={() => zoomBy(1.18)} />
          <IconButton icon={Expand} label="Fit to content" size={13} onClick={fitToContent} />
          <IconButton
            icon={Orbit}
            label="Auto-arrange — regroup all cards"
            size={13}
            onClick={autoArrange}
          />
        </div>

        {/* Connect-mode HUD */}
        {linkFrom ? (
          <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary-edge bg-overlay px-3.5 py-1.5 text-11 text-ink-soft shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            <Link2 size={11} className="text-primary" aria-hidden />
            <span>Click another card to connect them</span>
            <Kbd>Esc</Kbd>
          </div>
        ) : null}

        {/* Selection HUD */}
        {selectedIds.size >= 2 ? (
          <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-history/40 bg-overlay px-3.5 py-1.5 text-11 text-ink-soft shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
            <span className="mono font-semibold text-history">{selectedIds.size}</span>
            <span>selected — drag any card to move them together</span>
            <Kbd>Esc</Kbd>
          </div>
        ) : null}

        {/* Minimap */}
        {minimap && !empty ? (
          <div
            className="absolute right-3 bottom-3 z-10 overflow-hidden rounded-lg border border-line-modal bg-overlay/90"
            style={{ width: minimap.MW, height: minimap.MH }}
            onPointerDown={onMinimapDown}
            title="Minimap — click to jump"
          >
            {minimap.rects.map((r) => (
              <span
                key={r.id}
                className="absolute rounded-[2px] opacity-60"
                style={{ left: r.x, top: r.y, width: Math.max(3, r.w), height: Math.max(2, r.h), background: r.color }}
              />
            ))}
            <span
              className="absolute rounded-[3px] border border-primary"
              style={{
                left: minimap.view.x,
                top: minimap.view.y,
                width: minimap.view.w,
                height: minimap.view.h,
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

type BoardCardProps = {
  card: CardModel;
  /** User rename — replaces the generated kind label in the card header. */
  overrideLabel?: string;
  busyId: number | null;
  busyKind: string | null;
  onConfirmCluster: (hub: SourceCardModel) => void;
  selectedPath: string | null;
  isStaged: (path: string) => boolean;
  onSelect: (ref: { kind: "folder" | "file"; path: string; name: string; bytes: number }) => void;
  onUnpin: (path: string) => void;
  onStageFinding: (f: Finding) => void;
  onConfirm: (f: Finding) => void;
  onDismiss: (f: Finding) => void;
  onNoteChange: (id: string, text: string) => void;
  onNoteDelete: (id: string) => void;
  tree: ReturnType<typeof useIndexData>["tree"];
  overviewFolderMedia: Array<{ folder_path: string; media_kind: string; total_bytes: number }>;
  lensByPath: ReturnType<typeof useIndexData>["lensByPath"];
};

function BoardCard(props: BoardCardProps) {
  const { card } = props;
  switch (card.kind) {
    case "enable":
      return (
        <div className="rounded-xl border border-line-modal bg-inset p-3 shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
          <EnableIntelligenceCard />
        </div>
      );
    case "note":
      return <NoteCard {...props} note={card.note} />;
    case "finding":
      return <FindingCard {...props} finding={card.finding} />;
    case "source":
      return <SourceCard {...props} source={card} />;
    case "dup":
      return <DupCard {...props} dup={card} />;
    case "pin":
      return <PinCard {...props} pin={card.pin} />;
  }
}

function CardShell({
  accent,
  children,
  selected,
}: {
  accent?: string;
  children: React.ReactNode;
  selected?: boolean;
}) {
  return (
    <div
      className="overflow-hidden rounded-xl border bg-inset shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-shadow"
      style={{
        borderColor: selected ? "var(--color-primary)" : (accent ?? "var(--color-line-modal)"),
        boxShadow: selected ? "0 0 0 1px var(--color-primary), 0 8px 30px rgba(0,0,0,0.4)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function CardHeader({
  icon: Icon,
  tint,
  label,
  right,
}: {
  icon: typeof Sparkles;
  tint: string;
  label: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
      <span
        className="flex h-5 w-5 items-center justify-center rounded-md"
        style={{ background: `color-mix(in srgb, ${tint} 15%, transparent)`, color: tint }}
      >
        <Icon size={11} strokeWidth={2.2} aria-hidden />
      </span>
      <span className="text-10 font-semibold tracking-[0.1em] text-label uppercase">{label}</span>
      <span className="ml-auto flex items-center gap-1">{right}</span>
    </div>
  );
}

function FindingCard({
  finding,
  overrideLabel,
  busyId,
  isStaged,
  onStageFinding,
  onConfirm,
  onDismiss,
  lensByPath,
}: BoardCardProps & { finding: Finding }) {
  const staged = isStaged(finding.subject);
  const row = lensByPath.get(finding.subject);
  const verdict = row ? verdictForFolder(row) : "review";
  const busy = busyId === finding.id;
  return (
    <CardShell accent="var(--color-primary-edge)">
      <CardHeader
        icon={Sparkles}
        tint="var(--color-primary)"
        label={overrideLabel ?? "Finding"}
        right={<span className="mono text-9 text-label">{Math.round(finding.confidence * 100)}%</span>}
      />
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2 text-115">
          <span className="mono max-w-[46%] truncate font-medium text-ink" title={finding.subject}>
            {baseName(finding.subject)}
          </span>
          <span className="rounded-full border border-primary-edge bg-primary-wash px-1.5 py-px text-9 whitespace-nowrap text-primary-ink">
            {finding.predicate}
          </span>
          <span className="mono max-w-[46%] truncate text-ink-soft" title={finding.object}>
            {baseName(finding.object)}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-10 text-faint">
          <span>
            frees <span className="mono font-semibold text-primary-ink">{formatBytes(finding.bytes)}</span> if
            confirmed
          </span>
          <VerdictTag verdict={verdict} />
        </div>
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-primary/70"
            style={{ width: `${Math.round(finding.confidence * 100)}%` }}
          />
        </div>
      </div>
      <div className="flex gap-1.5 border-t border-line-soft px-3 py-2">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onConfirm(finding)}>
          <Check size={11} aria-hidden /> Confirm
        </Button>
        <Button size="sm" disabled={busy} onClick={() => onDismiss(finding)}>
          Dismiss
        </Button>
        <Button
          size="sm"
          variant="subtle"
          className="ml-auto"
          disabled={busy || !canStage(verdict, finding.bytes)}
          onClick={() => onStageFinding(finding)}
        >
          {staged ? <Check size={11} aria-hidden /> : null}
          {staged ? "Staged" : "Stage"}
        </Button>
      </div>
    </CardShell>
  );
}

function SourceCard({
  source,
  overrideLabel,
  busyKind,
  onConfirmCluster,
}: BoardCardProps & { source: SourceCardModel }) {
  // Discoveries reference both files and folders as origins — a trailing
  // extension is the only signal the board has to pick the right glyph.
  const Icon = /\.[A-Za-z0-9]{1,8}$/.test(baseName(source.path)) ? File : Folder;
  const busy = busyKind === source.id;
  return (
    <CardShell accent="color-mix(in srgb, var(--color-cat-archive) 40%, transparent)">
      <CardHeader
        icon={Icon}
        tint="var(--color-cat-archive)"
        label={overrideLabel ?? "Source"}
        right={<span className="mono text-9 text-label">{formatCount(source.count)} linked</span>}
      />
      <div className="px-3 py-2.5">
        <div className="truncate text-125 font-medium text-ink" title={source.path}>
          {baseName(source.path)}
        </div>
        <div className="mono mt-0.5 truncate text-9 text-faint" title={source.path}>
          {source.path}
        </div>
        <div className="mt-1.5 text-10 text-faint">
          <span className="mono font-semibold text-ink-soft">{formatCount(source.count)}</span> findings ·{" "}
          <span className="mono font-semibold text-primary-ink">{formatBytes(source.bytes)}</span> reclaimable
          if confirmed
        </div>
      </div>
      <div className="flex border-t border-line-soft px-3 py-2">
        <Button size="sm" variant="subtle" disabled={busy} onClick={() => onConfirmCluster(source)}>
          {busy ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <Check size={11} aria-hidden />}{" "}
          Confirm all {formatCount(source.count)}
        </Button>
      </div>
    </CardShell>
  );
}

function DupCard({ dup, overrideLabel }: BoardCardProps & { dup: Extract<CardModel, { kind: "dup" }> }) {
  const { setView } = useWorkspace();
  return (
    <CardShell accent="color-mix(in srgb, var(--color-danger) 40%, transparent)">
      <CardHeader
        icon={Copy}
        tint="var(--color-danger)"
        label={overrideLabel ?? "Duplicate group"}
        right={
          <Tag tone={dup.confidence >= 0.99 ? "green" : "neutral"}>
            {dup.confidence >= 0.99 ? "VERIFIED" : dup.confidence >= 0.8 ? "SAMPLED" : "SIZE MATCH"}
          </Tag>
        }
      />
      <div className="px-3 py-2.5">
        <div className="text-115 text-ink">
          <span className="mono font-semibold">{dup.copies}</span> identical copies ·{" "}
          <span className="mono">{formatBytes(dup.size)}</span> each
        </div>
        <div className="mt-1.5 text-10 text-faint">
          keep one, free <span className="mono font-semibold text-danger">{formatBytes(dup.waste)}</span>
        </div>
        <div className="mt-2 flex gap-[2px]">
          {Array.from({ length: Math.min(dup.copies, 8) }, (_, i) => (
            <span
              key={i}
              className="h-2 flex-1 rounded-[2px]"
              style={{
                background:
                  i === 0 ? "var(--color-primary)" : "color-mix(in srgb, var(--color-danger) 55%, transparent)",
              }}
              title={i === 0 ? "the copy you keep" : "redundant copy"}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-1.5 border-t border-line-soft px-3 py-2">
        <Button size="sm" onClick={() => setView("duplicates")}>
          Review copies →
        </Button>
      </div>
    </CardShell>
  );
}

function PinCard({
  pin,
  overrideLabel,
  selectedPath,
  onSelect,
  onUnpin,
  isStaged,
  tree,
  overviewFolderMedia,
  lensByPath,
}: BoardCardProps & { pin: PinnedCard }) {
  const node = tree?.byPath.get(pin.path);
  const children = (node?.childrenPaths ?? [])
    .map((p) => tree?.byPath.get(p))
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .slice(0, 6);
  const dominant = useMemo(() => {
    const best = new Map<string, { kind: string; bytes: number }>();
    for (const fm of overviewFolderMedia) {
      const prev = best.get(fm.folder_path);
      if (!prev || fm.total_bytes > prev.bytes)
        best.set(fm.folder_path, { kind: fm.media_kind, bytes: fm.total_bytes });
    }
    return best;
  }, [overviewFolderMedia]);
  const rects = useMemo(
    () => squarify(children.map((c) => ({ ref: c, value: c.bytes })), 0, 0, CARD_W - 26, 84),
    [children]
  );
  const row = lensByPath.get(pin.path);
  const verdict = row ? verdictForFolder(row) : null;
  const staged = isStaged(pin.path);

  return (
    <CardShell
      accent="color-mix(in srgb, var(--color-history) 40%, transparent)"
      selected={selectedPath === pin.path}
    >
      <CardHeader
        icon={Folder}
        tint="var(--color-history)"
        label={overrideLabel ?? "Pinned folder"}
        right={<IconButton icon={PinOff} label="Unpin" size={11} onClick={() => onUnpin(pin.path)} />}
      />
      <button
        type="button"
        className="block w-full px-3 py-2.5 text-left"
        onClick={() => onSelect({ kind: "folder", path: pin.path, name: pin.name, bytes: pin.bytes })}
        title="Open in Inspector"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-125 font-medium text-ink">{pin.name}</span>
          <span className="mono text-11 text-muted">{formatBytes(pin.bytes)}</span>
        </div>
        {rects.length ? (
          <div className="relative mt-2 h-[84px] overflow-hidden rounded-md">
            {rects.map(({ ref: child, x, y, w, h }) => (
              <span
                key={child.path}
                className="absolute overflow-hidden rounded-[3px] px-1 text-[8px] leading-[14px] text-ink-soft/80"
                style={{
                  left: x + 1,
                  top: y + 1,
                  width: Math.max(0, w - 2),
                  height: Math.max(0, h - 2),
                  background: `color-mix(in srgb, ${categoryOf(dominant.get(child.path)?.kind).color} 22%, var(--color-window))`,
                }}
                title={`${child.name} · ${formatBytes(child.bytes)}`}
              >
                {w > 44 && h > 15 ? child.name : ""}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-2 rounded-md border border-dashed border-line-modal p-2 text-center text-9 text-label">
            no subfolders
          </div>
        )}
        <div className="mt-2 flex items-center justify-between">
          {verdict ? <VerdictTag verdict={verdict} /> : <span />}
          {staged ? (
            <span className="flex items-center gap-1 text-9 text-primary-ink">
              <Check size={10} aria-hidden /> staged
            </span>
          ) : null}
        </div>
      </button>
    </CardShell>
  );
}

function NoteCard({ note, overrideLabel, onNoteChange, onNoteDelete }: BoardCardProps & { note: NoteModel }) {
  return (
    <div className="overflow-hidden rounded-xl border border-dashed border-line-modal bg-inset/80 shadow-[0_8px_30px_rgba(0,0,0,0.4)]">
      <CardHeader
        icon={StickyNote}
        tint="var(--color-warn)"
        label={overrideLabel ?? "Note"}
        right={<IconButton icon={X} label="Delete note" size={11} onClick={() => onNoteDelete(note.id)} />}
      />
      <textarea
        defaultValue={note.text}
        onBlur={(e) => onNoteChange(note.id, e.target.value)}
        placeholder="Write your reasoning…"
        className="h-[96px] w-full resize-none bg-transparent px-3 py-2 text-115 leading-relaxed text-ink-soft outline-none placeholder:text-label"
      />
    </div>
  );
}
