import { Sparkles } from "lucide-react";
import { useEnableIntelligence } from "../hooks/useEnableIntelligence";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";

/**
 * The opt-in CTA shown wherever intelligence is required but off (Inspector, Board lens).
 * One component so the empty state is identical everywhere — the locked honesty decision.
 */
export function EnableIntelligenceCard() {
  const { enable, busy, error } = useEnableIntelligence();
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary-dim text-primary">
          <Sparkles size={15} strokeWidth={2} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 text-115 leading-snug text-muted">
          Classifies every folder on-device — why it exists, what depends on it, what's reclaimable.
        </span>
        <Button variant="primary" size="sm" className="flex-none" disabled={busy} onClick={() => void enable()}>
          {busy ? "Starting…" : "Enable intelligence"}
        </Button>
      </div>
      {error ? (
        <div className="mt-2.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-11 text-danger">
          Couldn't enable: {error}
        </div>
      ) : null}
    </Card>
  );
}
