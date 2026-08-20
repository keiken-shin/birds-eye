import { useCallback, useEffect, useState } from "react";
import { Check, Lightbulb, X } from "lucide-react";
import { formatBytes, formatCount } from "@bridge/domain";
import {
  confirmDiscovery,
  confirmDiscoveryPattern,
  listDiscoveries,
  rejectDiscovery,
  rejectDiscoveryPattern,
  type NativeDiscovery,
} from "@bridge/nativeClient";
import { FINDING_KINDS, baseName, parseFinding, type Finding } from "../lib/discoveries";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { Card, SectionLabel } from "./ui/Card";
import { Button } from "./ui/Button";

/**
 * Findings waiting on a yes or no, and the only place they can get one.
 *
 * This is not a nicety. A finding is a *candidate* relation; the backend's
 * heuristics only ever propose one. Two of the four reasons a file can be called
 * safe to delete — "a copy of something you still have" and "made from a file
 * you still have" — require the confirmed relation to exist, so with nowhere to
 * confirm, those two reasons never fire for anybody. It lived inside the Board
 * canvas, which is why replacing that view had to start here.
 *
 * It sits above Clean up because that is where the consequence lands: say yes
 * here and the space shows up in the list below.
 */

const KIND_COPY: Record<string, { title: string; blurb: string; verb: string }> = {
  "derivedFrom-pattern": {
    title: "Made from a file you still have",
    blurb: "If that's right, the copy is safe to delete — you can make it again.",
    verb: "was made from",
  },
  "backupOf-pair": {
    title: "A second copy of something you still have",
    blurb: "If that's right, the spare is safe to delete — the original stays where it is.",
    verb: "is a copy of",
  },
};

type Group = { kind: string; findings: Finding[]; bytes: number };

export function FindingsReview() {
  const { indexPath, ontologyEnabled } = useWorkspace();
  const { refreshData, dataVersion } = useIndexData();
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!indexPath) return;
    const perKind = await Promise.all(
      FINDING_KINDS.map((kind) =>
        listDiscoveries(indexPath, kind, 60).catch(() => [] as NativeDiscovery[])
      )
    );
    setGroups(
      FINDING_KINDS.map((kind, i) => {
        const findings = perKind[i]
          .map(parseFinding)
          .filter((f): f is Finding => f !== null && f.status === "Pending");
        return { kind, findings, bytes: findings.reduce((s, f) => s + f.bytes, 0) };
      }).filter((g) => g.findings.length > 0)
    );
    setLoaded(true);
  }, [indexPath]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  /** Act, then reload both this list and the candidate lists it feeds. */
  const act = async (key: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await run();
      await load();
      await refreshData();
    } finally {
      setBusy(null);
    }
  };

  if (!ontologyEnabled || !loaded || !groups.length || !indexPath) return null;

  const total = groups.reduce((s, g) => s + g.findings.length, 0);

  return (
    <Card className="mb-4 p-0">
      <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
        <Lightbulb size={15} className="flex-none translate-y-0.5 text-primary-ink" aria-hidden />
        <SectionLabel className="flex-none">Worth a look</SectionLabel>
        <span className="min-w-0 flex-1 truncate text-115 text-ink-soft">
          {formatCount(total)} {total === 1 ? "thing" : "things"} Bird's Eye spotted but won't act on
          until you say so.
        </span>
      </div>

      {groups.map((group) => {
        const copy = KIND_COPY[group.kind];
        if (!copy) return null;
        return (
          <section key={group.kind} className="border-b border-line-soft last:border-b-0">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-125 font-medium text-ink">{copy.title}</div>
                <div className="text-105 text-dim">
                  {copy.blurb} {formatBytes(group.bytes)} across{" "}
                  {formatCount(group.findings.length)}.
                </div>
              </div>
              <Button
                size="sm"
                variant="subtle"
                icon={Check}
                disabled={busy !== null}
                onClick={() =>
                  void act(`all:${group.kind}`, () => confirmDiscoveryPattern(indexPath, group.kind))
                }
              >
                Yes to all
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={X}
                disabled={busy !== null}
                onClick={() =>
                  void act(`none:${group.kind}`, () => rejectDiscoveryPattern(indexPath, group.kind))
                }
              >
                No to all
              </Button>
            </div>

            <ul className="max-h-[240px] overflow-y-auto">
              {group.findings.map((f) => (
                <li
                  key={f.id}
                  className="flex items-center gap-2 border-t border-line-soft px-4 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-12 text-ink" title={`${f.subject}\n${f.object}`}>
                      <span className="mono font-medium">{baseName(f.subject)}</span>{" "}
                      <span className="text-dim">{copy.verb}</span>{" "}
                      <span className="mono">{baseName(f.object)}</span>
                    </div>
                    <div className="mono truncate text-10 text-faint">{f.subject}</div>
                  </div>
                  <span className="mono flex-none text-11 text-muted">{formatBytes(f.bytes)}</span>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={busy !== null}
                    onClick={() => void act(`y:${f.id}`, () => confirmDiscovery(indexPath, f.id))}
                  >
                    Yes
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void act(`n:${f.id}`, () => rejectDiscovery(indexPath, f.id))}
                  >
                    No
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}
