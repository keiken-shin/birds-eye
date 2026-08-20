import { useEffect, useMemo, useState } from "react";
import { FolderInput, Inbox, ScanLine, Trash2, X } from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import { REASON_LABELS } from "@bridge/nativeClient";
import { useWorkspace } from "../../state/workspaceStore";
import { useIndexData } from "../../state/indexData";
import { Card, EmptyState, SectionLabel } from "../ui/Card";
import { Button } from "../ui/Button";
import { VerdictTag } from "../ui/Chip";
import { MoveDialog, type MoveTarget } from "../MoveDialog";
import { ViewHeader } from "./ViewHeader";
import type { StagedItem } from "../../state/types";
import { discardCarryover, readCarryover, type Carryover } from "../../lib/boardCarryover";
import { REMOTE_ACTION_HINT, capabilitiesForSource } from "../../lib/sourceCapabilities";

/**
 * The desk. Things you set aside while looking around, kept until you decide.
 *
 * This replaced a relationship canvas — drag, edges, hulls, a minimap — which
 * answered "what is related to what". That question belongs to the analysis
 * layer; the one worth a whole view is "what am I doing with these?".
 *
 * Deliberately not a board with columns. The moment it grows To do / Doing /
 * Done it is project-management software, and every file here still has to pass
 * a review gate before anything happens to it.
 */

export function StagedView() {
  const { staged, toggleStaged, clearStaged, groupStaged, openReview, setOverlay, select, indexPath } =
    useWorkspace();
  const { status, activeEntry } = useIndexData();
  // Moving and deleting happen on disk — neither is available for a scan of
  // another machine, so the desk keeps the items and drops the two actions.
  const canAct = capabilitiesForSource(activeEntry?.source).mutate;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [newGroup, setNewGroup] = useState("");
  const [moveTargets, setMoveTargets] = useState<MoveTarget[] | null>(null);
  const [carryover, setCarryover] = useState<Carryover | null>(null);

  // The old canvas is gone, but what someone typed on it is not ours to bin
  // quietly. Shown once, here, and only removed when they say so.
  useEffect(() => {
    setCarryover(indexPath ? readCarryover(indexPath) : null);
  }, [indexPath]);

  const groups = useMemo(() => {
    // Keyed on the group name itself, null included — a Map takes null as a key,
    // so there is no sentinel string to collide with a group someone actually
    // named. (There was one, and it hid a stray NUL byte in this file.)
    const by = new Map<string | null, StagedItem[]>();
    for (const item of staged) {
      const key = item.groupName ?? null;
      const list = by.get(key);
      if (list) list.push(item);
      else by.set(key, [item]);
    }
    // Named groups first, alphabetically; loose items last.
    return [...by.entries()].sort(([a], [b]) =>
      a === null ? 1 : b === null ? -1 : a.localeCompare(b)
    );
  }, [staged]);

  const totalBytes = staged.reduce((s, i) => s + i.bytes, 0);

  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const fileTargets = (items: StagedItem[]): MoveTarget[] =>
    items
      .filter((i) => i.kind === "file" && i.fileId != null)
      .map((i) => ({ path: i.path, fileId: i.fileId as number }));

  if (status === "no-index") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ViewHeader title="Staged" />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <EmptyState
            icon={ScanLine}
            title="Scan a folder first"
            hint="Once Bird's Eye has read a folder you can set things aside here while you decide."
            action={{ label: "Scan a folder", icon: ScanLine, onClick: () => setOverlay("scan") }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader
        title="Staged"
        sub={
          staged.length ? (
            <>
              <span className="mono font-semibold text-ink">{formatCount(staged.length)}</span> set
              aside · <span className="mono">{formatBytes(totalBytes)}</span>
            </>
          ) : undefined
        }
        actions={
          staged.length ? (
            <Button variant="ghost" size="sm" onClick={clearStaged}>
              Clear all
            </Button>
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1080px] flex-col gap-4 p-4">
          {carryover ? (
            <Card className="p-4">
              <SectionLabel className="mb-1.5">From your old canvas</SectionLabel>
              <p className="mb-2.5 text-115 text-ink-soft">
                Findings used to be a canvas you could write on. It is a staging desk now — but
                you'd typed these, so here they are before they go.
              </p>
              {carryover.notes.length ? (
                <ul className="mb-2 flex flex-col gap-1">
                  {carryover.notes.map((n, i) => (
                    <li key={`n${i}`} className="rounded-[7px] bg-field px-2.5 py-1.5 text-115 text-ink">
                      {n}
                    </li>
                  ))}
                </ul>
              ) : null}
              {carryover.names.length ? (
                <p className="mb-2 text-105 text-dim">
                  Names you gave cards:{" "}
                  <span className="mono text-ink-soft">{carryover.names.join(" · ")}</span>
                </p>
              ) : null}
              {carryover.edges.length ? (
                <p className="mb-2 text-105 text-dim">
                  Labels on connections you drew:{" "}
                  <span className="mono text-ink-soft">{carryover.edges.join(" · ")}</span>
                </p>
              ) : null}
              <Button
                size="sm"
                variant="subtle"
                onClick={() => {
                  if (indexPath) discardCarryover(indexPath);
                  setCarryover(null);
                }}
              >
                Got it — remove
              </Button>
            </Card>
          ) : null}

          {!staged.length ? (
            <EmptyState
              icon={Inbox}
              title="Nothing set aside yet"
              hint="Anywhere you see Stage, the file or folder lands here. It stays until you decide — closing Bird's Eye doesn't clear it."
            />
          ) : null}

          {groups.map(([name, items]) => {
            const named = name !== null;
            const bytes = items.reduce((s, i) => s + i.bytes, 0);
            const movable = fileTargets(items);
            return (
              <Card key={name ?? "__loose"} className="be-rise p-0">
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
                  <SectionLabel className="flex-none">
                    {named ? name : "Not in a group"}
                  </SectionLabel>
                  <span className="min-w-0 flex-1 text-105 text-dim">
                    {formatCount(items.length)} · {formatBytes(bytes)}
                  </span>
                  {movable.length && canAct ? (
                    <Button
                      size="sm"
                      variant="subtle"
                      icon={FolderInput}
                      onClick={() => setMoveTargets(movable)}
                    >
                      Move {formatCount(movable.length)}…
                    </Button>
                  ) : null}
                  {named ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        groupStaged(
                          items.map((i) => i.path),
                          null
                        )
                      }
                    >
                      Ungroup
                    </Button>
                  ) : null}
                </div>

                <ul>
                  {items.map((item) => (
                    <li
                      key={item.path}
                      className="flex items-center gap-2.5 border-b border-line-soft px-4 py-2 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.name}`}
                        checked={picked.has(item.path)}
                        onChange={() => toggle(item.path)}
                        className="flex-none accent-[var(--color-primary)]"
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() =>
                          select({
                            kind: item.kind,
                            path: item.path,
                            name: item.name,
                            bytes: item.bytes,
                            fileId: item.fileId,
                          })
                        }
                      >
                        <div className="truncate text-12 font-medium text-ink">{item.name}</div>
                        <div className="mono truncate text-10 text-faint" title={item.path}>
                          {item.path}
                        </div>
                        {item.note ? (
                          <div className="truncate text-105 text-ink-soft">{item.note}</div>
                        ) : null}
                      </button>
                      {item.reason ? (
                        // A staged reason is sometimes a backend key
                        // (`safe-derivative`, `scratch`) and sometimes free text
                        // a view wrote ("duplicate copy", "untouched 8 months").
                        // Map the keys; pass the rest through — this view was
                        // showing raw keys, which is `src/` vocabulary in front
                        // of a person, and the copy gate can't see it because
                        // the strings arrive as data, not as source prose.
                        <span className="hidden max-w-[220px] truncate text-105 text-dim md:block">
                          {REASON_LABELS[item.reason] ?? item.reason}
                        </span>
                      ) : null}
                      <VerdictTag verdict={item.verdict} />
                      <span className="mono flex-none text-11 text-muted">
                        {formatBytes(item.bytes)}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={X}
                        aria-label={`Take ${item.name} off the desk`}
                        onClick={() => toggleStaged(item)}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}

          {staged.length ? (
            <Card className="flex flex-wrap items-center gap-2 px-4 py-3">
              <span className="text-105 text-dim">
                {picked.size
                  ? `${formatCount(picked.size)} selected`
                  : "Select some to put them in a group."}
              </span>
              <div className="min-w-0 flex-1" />
              <input
                value={newGroup}
                onChange={(e) => setNewGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !newGroup.trim() || !picked.size) return;
                  groupStaged([...picked], newGroup.trim());
                  setNewGroup("");
                  setPicked(new Set());
                }}
                placeholder="Group name — e.g. Archive"
                spellCheck={false}
                aria-label="Group name"
                className="w-[220px] rounded-[7px] border border-line-input bg-field px-2.5 py-1.5 text-115 text-ink placeholder:text-dim outline-none focus:border-primary-edge"
              />
              <Button
                size="sm"
                variant="subtle"
                disabled={!picked.size || !newGroup.trim()}
                onClick={() => {
                  groupStaged([...picked], newGroup.trim());
                  setNewGroup("");
                  setPicked(new Set());
                }}
              >
                Put in group
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={Trash2}
                disabled={!canAct}
                title={canAct ? undefined : REMOTE_ACTION_HINT}
                onClick={() => openReview(picked.size ? [...picked] : undefined)}
              >
                {picked.size ? `Review & delete ${formatCount(picked.size)}` : "Review & delete all"}
              </Button>
            </Card>
          ) : null}
        </div>
      </div>

      {moveTargets ? (
        <MoveDialog
          files={moveTargets}
          onClose={() => setMoveTargets(null)}
          onMoved={(_dest, movedPaths) => {
            // Moved files leave the desk — the thing you set aside is dealt with.
            for (const p of movedPaths) {
              const item = staged.find((s) => s.path === p);
              if (item) toggleStaged(item);
            }
          }}
        />
      ) : null}
    </div>
  );
}
