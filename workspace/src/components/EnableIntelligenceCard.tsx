import { useEnableIntelligence } from "../hooks/useEnableIntelligence";

/**
 * The opt-in CTA shown wherever intelligence is required but off (Inspector, Board lens).
 * One component so the empty state is identical everywhere — the locked honesty decision.
 */
export function EnableIntelligenceCard() {
  const { enable, busy, error } = useEnableIntelligence();
  return (
    <div className="rounded-[9px] border border-primary/30 bg-primary/[0.06] p-3">
      <div className="mb-1 text-12 font-semibold text-primary">Enable intelligence</div>
      <div className="mb-3 text-[11.5px] leading-relaxed text-muted">
        Classify this index to reveal why each folder exists, what's reclaimable, and a safety
        verdict. Non-destructive and reversible.
      </div>
      {error && (
        <div className="mb-2 rounded-[6px] border border-danger/30 bg-danger/[0.08] px-2.5 py-1.5 text-[10.5px] text-danger">
          {error}
        </div>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => void enable()}
        className="w-full rounded-[8px] bg-primary py-2 text-12 font-semibold text-on-primary disabled:opacity-50"
      >
        {busy ? "Enriching…" : "Enable & enrich"}
      </button>
    </div>
  );
}
