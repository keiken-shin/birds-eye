import { useState } from "react";
import { Keyboard, RefreshCw, ShieldCheck, Sparkles, Zap, type LucideIcon } from "lucide-react";
import type { ScanStrategy } from "@bridge/domain";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";
import { useEnableIntelligence } from "../hooks/useEnableIntelligence";
import { getDefaultStrategy, setDefaultStrategy } from "../lib/prefs";
import { REMOTE_RESCAN_HINT, capabilitiesForSource } from "../lib/sourceCapabilities";
import { OverlayShell } from "./ui/OverlayShell";
import { SectionLabel } from "./ui/Card";
import { Button } from "./ui/Button";
import { Tag } from "./ui/Chip";

const METHODS: Array<{ id: ScanStrategy; title: string; icon: LucideIcon; note: string }> = [
  { id: "smart", title: "Smart", icon: Sparkles, note: "full walk + content hashing · most accurate" },
  { id: "metadata", title: "Metadata only", icon: Zap, note: "fast index without hashing · seconds" },
];

/**
 * Settings — deliberately small and honest. The app has no backend settings store, and the
 * theme is dark-only, so this holds the one real UI default the app can't derive: the strategy a
 * new scan starts on (persisted in localStorage, consumed by ScanOverlay). No accent/density
 * knobs — they'd only half-apply over the half-tokenized styles, which would be theater.
 */
export function SettingsOverlay() {
  const { overlay, setOverlay, setView, ontologyEnabled, indexPath } = useWorkspace();
  const { activeEntry } = useIndexData();
  const { enqueue } = useScanController();
  const {
    enable,
    disable,
    busy: toggleBusy,
    error: toggleError,
  } = useEnableIntelligence();
  const [strategy, setStrategy] = useState<ScanStrategy>(getDefaultStrategy);
  const [rerunBusy, setRerunBusy] = useState(false);

  if (overlay !== "settings") return null;
  const close = () => setOverlay(null);
  const root = activeEntry?.root_path ?? null;
  const canRescan = capabilitiesForSource(activeEntry?.source).mutate;

  const pick = (s: ScanStrategy) => {
    setStrategy(s);
    setDefaultStrategy(s);
  };

  const rerunEnrichment = () => {
    // Same guard as the Scans view: this rescan walks THIS PC, so an index of another
    // machine would come back full of local paths under the remote's name.
    if (!root || rerunBusy || !canRescan) return;
    setRerunBusy(true);
    // An incremental rescan's phase 2 re-runs enrichment with live progress.
    enqueue(root, strategy);
    setOverlay(null);
    setView("scans");
    setRerunBusy(false);
  };

  return (
    <OverlayShell
      title="Settings"
      width={480}
      onClose={close}
      footer={
        <Button variant="ghost" size="sm" icon={Keyboard} onClick={() => setOverlay("shortcuts")}>
          Keyboard shortcuts
        </Button>
      }
    >
      <div className="flex flex-col gap-5 p-4.5">
        <section>
          <SectionLabel className="mb-2">Default scan method</SectionLabel>
          <div role="radiogroup" aria-label="Default scan method" className="grid grid-cols-2 gap-2">
            {METHODS.map((m) => {
              const on = strategy === m.id;
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => pick(m.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    on ? "border-primary-edge bg-primary-dim" : "border-line-modal hover:border-line-strong"
                  }`}
                >
                  <span
                    className={`flex items-center gap-1.5 text-12 font-medium ${
                      on ? "text-primary-ink" : "text-muted"
                    }`}
                  >
                    <Icon size={13} strokeWidth={2} aria-hidden />
                    {m.title}
                  </span>
                  <span className="mt-0.5 block text-10 text-dim">{m.note}</span>
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-10 text-dim">New scans start on this — you can still switch per scan.</div>
        </section>

        {/* The analysis runs by default. This is the way out for people who want
            a plain size scanner — and the way back in. */}
        <section>
          <SectionLabel className="mb-2">The analysis</SectionLabel>
          <div className="rounded-lg border border-line bg-inset px-3 py-2.5">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                role="switch"
                checked={!ontologyEnabled}
                disabled={!indexPath || toggleBusy}
                onChange={(e) => void (e.target.checked ? disable() : enable())}
                className="mt-0.5 h-3.5 w-3.5 flex-none accent-[var(--color-primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-115 text-muted">
                  Just show me sizes — skip the analysis
                </span>
                <span className="mt-0.5 block text-105 leading-relaxed text-dim">
                  {ontologyEnabled
                    ? "Bird's Eye is working out what's safe to delete and why. Turn this on and it will only measure sizes."
                    : "Bird's Eye is only measuring sizes. Turn this off and it will tell you what's safe to delete, and why."}
                </span>
              </span>
            </label>
            {toggleError ? (
              <div className="mt-2 rounded-lg border border-danger/40 bg-danger/10 px-2.5 py-1.5 text-105 text-danger">
                {toggleError}
              </div>
            ) : null}
            {ontologyEnabled && root ? (
              <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2">
                <span className="mono min-w-0 flex-1 truncate text-10 text-dim">{root}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RefreshCw}
                  disabled={rerunBusy || !canRescan}
                  title={canRescan ? undefined : REMOTE_RESCAN_HINT}
                  onClick={rerunEnrichment}
                  className="flex-none"
                >
                  {rerunBusy ? "Starting…" : "Run it again"}
                </Button>
              </div>
            ) : null}
          </div>
        </section>

        <section>
          <SectionLabel className="mb-2">Privacy</SectionLabel>
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-inset px-3 py-2.5">
            <ShieldCheck size={15} strokeWidth={2} className="flex-none text-primary-ink" aria-hidden />
            <span className="text-115 text-muted">It works offline. Nothing is uploaded.</span>
          </div>
        </section>

        <section>
          <SectionLabel className="mb-2">Appearance</SectionLabel>
          <div className="flex items-center gap-2.5 rounded-lg border border-line bg-inset px-3 py-2.5">
            <Tag tone="neutral">Dark</Tag>
            <span className="text-105 text-dim">more themes later</span>
          </div>
        </section>
      </div>
    </OverlayShell>
  );
}
