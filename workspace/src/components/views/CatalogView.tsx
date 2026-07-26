import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, X, ChevronDown, ChevronRight } from "lucide-react";
import { formatBytes } from "@bridge/domain";
import {
  rejectDiscovery,
  relocationCards,
  relocationMembers,
  type NativeRelocationMember,
} from "@bridge/nativeClient";
import { destinationFor, parseCards, rankCards, sourceLabel, type RelocationCard } from "../../lib/catalog";
import { useIndexData } from "../../state/indexData";
import { useWorkspace } from "../../state/workspaceStore";
import { EnableIntelligenceCard } from "../EnableIntelligenceCard";
import { Button } from "../ui/Button";
import { Card, SectionLabel } from "../ui/Card";
import { ViewHeader } from "./ViewHeader";

/**
 * Relocation suggestions: "these files belong somewhere else". Accepting a card
 * stages its members as moves; nothing touches disk until the review gate.
 *
 * Written as a body component under its own ViewHeader so that if Cleanup and
 * Catalog are ever merged behind one header, the toggle drops into a parent and
 * this body is untouched.
 */
export function CatalogView() {
  // `ontologyEnabled` lives on the workspace store; `ontology` (the status DTO)
  // comes from indexData. They are NOT on the same hook.
  const { indexPath, ontologyEnabled, toggleStagedMove, isMoveStaged } = useWorkspace();
  const { ontology } = useIndexData();

  const [cards, setCards] = useState<RelocationCard[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [members, setMembers] = useState<Record<number, NativeRelocationMember[]>>({});
  const [excluded, setExcluded] = useState<Record<number, Set<string>>>({});

  const load = useCallback(async () => {
    if (!indexPath) return;
    const rows = await relocationCards(indexPath);
    setCards(rankCards(parseCards(rows)));
  }, [indexPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Shared by expand (show the list) and accept (stage it): the payload embeds
  // only the first 50 members, so a card whose true count is higher needs the
  // full list fetched and cached before either can trust it's "everything".
  // When the embed already holds every member (member_count <= 50, the common
  // case), skip the round trip entirely.
  const ensureMembers = useCallback(
    async (card: RelocationCard) => {
      const cached = members[card.id];
      if (cached) return cached;
      if (card.payload.members.length >= card.payload.member_count || !indexPath) {
        return card.payload.members;
      }
      const full = await relocationMembers(indexPath, card.id);
      setMembers((prev) => ({ ...prev, [card.id]: full }));
      return full;
    },
    [members, indexPath]
  );

  const expand = useCallback(
    async (card: RelocationCard) => {
      if (expanded === card.id) {
        setExpanded(null);
        return;
      }
      setExpanded(card.id);
      await ensureMembers(card);
    },
    [expanded, ensureMembers]
  );

  const membersOf = useCallback(
    (card: RelocationCard) => members[card.id] ?? card.payload.members,
    [members]
  );

  const accept = useCallback(
    async (card: RelocationCard) => {
      const list = await ensureMembers(card);
      const skip = excluded[card.id] ?? new Set<string>();
      for (const member of list) {
        if (skip.has(member.path)) continue;
        toggleStagedMove({
          path: member.path,
          name: member.name,
          bytes: member.size,
          to: destinationFor(card.payload.destination, member.name),
          destinationExists: card.payload.destination_exists,
          fileId: member.file_id,
          discoveryId: card.id,
        });
      }
      setCards((prev) => prev?.filter((c) => c.id !== card.id) ?? null);
    },
    [ensureMembers, excluded, toggleStagedMove]
  );

  const reject = useCallback(
    async (card: RelocationCard) => {
      setCards((prev) => prev?.filter((c) => c.id !== card.id) ?? null);
      if (indexPath) await rejectDiscovery(indexPath, card.id);
    },
    [indexPath]
  );

  const total = useMemo(
    () => (cards ?? []).reduce((sum, c) => sum + c.payload.total_bytes, 0),
    [cards]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Catalog"
        sub={
          cards?.length
            ? `${cards.length} suggestion${cards.length === 1 ? "" : "s"} · ${formatBytes(total)}`
            : "Where your files should live"
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {/* `ontology === null` means "not loaded yet" — without this guard the
            enable CTA flashes on every startup, same as BoardView's findings tab. */}
        {ontology && !ontologyEnabled ? (
          // EnableIntelligenceCard already renders its own Card — don't wrap it in another.
          <div className="mt-6">
            <EnableIntelligenceCard />
          </div>
        ) : cards === null ? (
          <p className="mt-6 text-12 italic text-label">Looking for misplaced files…</p>
        ) : cards.length === 0 ? (
          <Card className="mt-6 p-4">
            <SectionLabel>Nothing to move</SectionLabel>
            <p className="mt-2 text-125 text-dim">
              Everything in your inbox folders already looks like it is where it belongs.
            </p>
          </Card>
        ) : (
          <div className="mt-4 flex flex-col gap-2.5">
            {cards.map((card) => {
              const open = expanded === card.id;
              const skip = excluded[card.id] ?? new Set<string>();
              const list = membersOf(card);
              const keeping = list.filter((m) => !skip.has(m.path));
              return (
                <Card key={card.id} className="p-3.5">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => void expand(card)}
                      aria-expanded={open}
                      aria-label={open ? "Collapse file list" : "Show files"}
                      title={open ? "Collapse" : "Show files"}
                      className="mt-0.5 flex-none text-faint transition-colors hover:text-ink"
                    >
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-135 text-ink">
                        {card.payload.member_count} {card.payload.kind}
                        {card.payload.member_count === 1 ? "" : "s"} → {card.payload.destination}
                      </p>
                      <p className="mt-1 text-115 text-dim">
                        {card.payload.reason}
                        {card.payload.destination_exists ? null : (
                          <span className="ml-2 rounded-full border border-line-modal px-2 py-0.5 text-105 text-faint">
                            will be created
                          </span>
                        )}
                      </p>
                      <p className="mono mt-1 text-105 text-faint">
                        {sourceLabel(card.payload.source)} · {formatBytes(card.payload.total_bytes)}
                        {keeping.length === list.length
                          ? null
                          : ` · ${list.length - keeping.length} excluded`}
                      </p>
                    </div>
                    <div className="flex flex-none gap-1.5">
                      <Button
                        variant="primary"
                        icon={Check}
                        disabled={keeping.length === 0}
                        onClick={() => void accept(card)}
                      >
                        Accept
                      </Button>
                      <Button icon={X} onClick={() => void reject(card)}>
                        Not this
                      </Button>
                    </div>
                  </div>

                  {open ? (
                    <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-3">
                      {list.map((member) => {
                        const off = skip.has(member.path);
                        return (
                          <li key={member.path} className="flex items-center gap-2 text-115">
                            <input
                              type="checkbox"
                              checked={!off}
                              aria-label={`Include ${member.name}`}
                              onChange={() =>
                                setExcluded((prev) => {
                                  const next = new Set(prev[card.id] ?? []);
                                  if (off) next.delete(member.path);
                                  else next.add(member.path);
                                  return { ...prev, [card.id]: next };
                                })
                              }
                            />
                            <span
                              className={`min-w-0 flex-1 truncate ${off ? "text-faint line-through" : "text-dim"}`}
                            >
                              {member.name}
                            </span>
                            <span className="mono flex-none text-105 text-faint">
                              {formatBytes(member.size)}
                            </span>
                            {isMoveStaged(member.path) ? (
                              <span className="flex-none text-105 text-primary-ink">staged</span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
