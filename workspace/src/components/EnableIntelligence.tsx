import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";
import { useEnableIntelligence } from "../hooks/useEnableIntelligence";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";

/**
 * Non-destructive prompt — appears once per index when the analysis is off.
 *
 * The analysis runs by default now, so an index reaches this state one of two
 * ways: it was scanned before that changed, or the user turned it off in
 * Settings. Either way the offer is the same one, worded as a thing that's
 * missing rather than a feature to unlock.
 */
export function EnableIntelligence() {
  const { indexPath, ontologyEnabled } = useWorkspace();
  const { ontology } = useIndexData();
  const { enable, busy, error } = useEnableIntelligence();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!indexPath) return;
    setDismissed(localStorage.getItem(`be.ws.enable.dismissed:${indexPath}`) === "1");
  }, [indexPath]);

  // copy-ok: code comment. `ontology === null` means the status read hasn't landed yet — showing the
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
            <div className="text-135 font-semibold text-ink">
              This index only knows how big things are
            </div>
            <div className="mt-1 text-115 leading-relaxed text-muted">
              Let Bird's Eye read your folders and it will tell you what's safe to delete and why —
              on the Map, in Findings, and in Clean up. It reads your own folder structure on this
              machine; nothing is uploaded. Runs in the background, so keep working.
            </div>
          </div>
        </div>
        {error ? (
          <div className="mt-3 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-11 text-danger">
            Couldn't start the analysis: {error}
          </div>
        ) : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={dismiss}>
            Not now
          </Button>
          <Button variant="primary" size="sm" icon={Sparkles} disabled={busy} onClick={() => void enable()}>
            {busy ? "Starting…" : "Run the analysis"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
