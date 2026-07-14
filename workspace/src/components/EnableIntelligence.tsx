import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { useEnableIntelligence } from "../hooks/useEnableIntelligence";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";

/** First-class, non-destructive opt-in prompt — appears once per index when intelligence is off. */
export function EnableIntelligence() {
  const { indexPath, ontologyEnabled } = useWorkspace();
  const { ontology } = useIndexData();
  const { enable, busy, error } = useEnableIntelligence();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!indexPath) return;
    setDismissed(localStorage.getItem(`be.ws.enable.dismissed:${indexPath}`) === "1");
  }, [indexPath]);

  // `ontology === null` means the status read hasn't landed yet — showing the
  // prompt then flashes it at every app start while a big index loads.
  if (!indexPath || ontology === null || ontologyEnabled || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(`be.ws.enable.dismissed:${indexPath}`, "1");
    setDismissed(true);
  };

  return (
    <div className="be-in absolute bottom-[74px] left-1/2 z-[55] w-[min(520px,calc(100%-32px))] -translate-x-1/2">
      <Card
        className="p-4 shadow-[0_18px_70px_rgba(0,0,0,.58)]"
        style={{ background: "var(--color-overlay)", borderColor: "var(--color-primary-edge)" }}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary-dim text-primary">
            <Sparkles size={15} strokeWidth={2} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-135 font-semibold text-ink">Understand what's safe to delete</div>
            <div className="mt-1 text-115 leading-relaxed text-muted">
              Classifies every folder on this machine — nothing leaves it. Unlocks safety verdicts
              on the treemap, findings on the Board, and cleanup recommendations. Runs as a
              background rescan; you can keep working.
            </div>
          </div>
        </div>
        {error ? (
          <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-11 text-danger">
            Couldn't enable: {error}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Not now
          </Button>
          <Button variant="primary" size="sm" icon={Sparkles} disabled={busy} onClick={() => void enable()}>
            {busy ? "Starting…" : "Enable intelligence"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
