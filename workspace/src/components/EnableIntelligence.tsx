import { useEffect, useState } from "react";
import { useWorkspace } from "../state/workspaceStore";
import { useEnableIntelligence } from "../hooks/useEnableIntelligence";

/** First-class, non-destructive opt-in prompt — appears once per index when intelligence is off. */
export function EnableIntelligence() {
  const { indexPath, ontologyEnabled } = useWorkspace();
  const { enable, busy, error } = useEnableIntelligence();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (!indexPath) return;
    setDismissed(localStorage.getItem(`be.ws.enable.dismissed:${indexPath}`) === "1");
  }, [indexPath]);

  if (!indexPath || ontologyEnabled || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(`be.ws.enable.dismissed:${indexPath}`, "1");
    setDismissed(true);
  };

  return (
    <div className="be-in absolute bottom-[74px] left-1/2 z-[55] w-[min(520px,calc(100%-32px))] -translate-x-1/2 rounded-[12px] border border-primary/40 bg-overlay p-4 shadow-[0_18px_70px_rgba(0,0,0,.58)]">
      <div className="mb-1 text-13 font-semibold text-primary">Cleanup intelligence</div>
      <div className="mb-3 text-[11.5px] leading-relaxed text-muted">
        Classify this index to reveal safety verdicts, what's reclaimable, and why each folder
        exists. Enabling is non-destructive and reversible at any time.
      </div>
      {error && (
        <div className="mb-3 rounded-[7px] border border-danger/30 bg-danger/[0.08] px-3 py-2 text-[11px] text-danger">
          Couldn't enable: {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="mono rounded-[7px] border border-white/15 px-3.5 py-1.5 text-11 text-white/60"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void enable()}
          className="rounded-[7px] bg-primary px-3.5 py-1.5 text-11 font-semibold text-on-primary disabled:opacity-50"
        >
          {busy ? "Enriching…" : "Enable & enrich"}
        </button>
      </div>
    </div>
  );
}
