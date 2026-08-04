import { Sparkles } from "lucide-react";
import { useEnableIntelligence } from "../hooks/useEnableIntelligence";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";

/**
 * Shown wherever the analysis is off (Inspector, Findings, Clean up, Organise).
 * One component so the empty state is identical everywhere — the locked honesty
 * decision.
 *
 * The analysis now runs by default, so this is the "you turned it off" path
 * rather than a first-run pitch: it explains what's missing and offers it back.
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
          This index only has sizes. Bird's Eye can read your folders and tell you what's safe to
          delete and why — on this machine, nothing uploaded.
        </span>
        <Button variant="primary" size="sm" className="flex-none" disabled={busy} onClick={() => void enable()}>
          {busy ? "Starting…" : "Run the analysis"}
        </Button>
      </div>
      {error ? (
        <div className="mt-2.5 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-11 text-danger">
          Couldn't start the analysis: {error}
        </div>
      ) : null}
    </Card>
  );
}
