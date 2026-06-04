import { useEffect, useState } from "react";
import { ontologyStatus, setOntologyEnabled } from "../nativeClient";

/** One-time, non-destructive per-index enable prompt (spec §14). */
export function OntologyEnablePrompt({ indexPath }: { indexPath: string }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const dismissed = localStorage.getItem(`be.ontology.prompt.dismissed:${indexPath}`) === "1";
    if (dismissed) return;
    void ontologyStatus(indexPath)
      .then((s) => {
        if (!cancelled && !s.enabled) setShow(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [indexPath]);

  if (!show) return null;

  const dismiss = () => {
    localStorage.setItem(`be.ontology.prompt.dismissed:${indexPath}`, "1");
    setShow(false);
  };

  const enable = async () => {
    setBusy(true);
    try {
      await setOntologyEnabled(indexPath, true);
      dismiss();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed bottom-24 left-1/2 z-30 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 border border-primary/40 bg-overlay p-5 shadow-[0_18px_70px_rgba(0,0,0,0.58)]">
      <h3 className="mb-1 text-base font-black uppercase text-primary">Cleanup Intelligence</h3>
      <p className="mb-4 text-12 text-muted">
        Birds Eye can classify this index to power safer dedup, the Cleanup engine, and Discoveries.
        Enabling is non-destructive and reversible at any time.
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={dismiss}
          className="border border-white/20 px-4 py-1 font-mono text-11 uppercase text-white/60"
        >
          Not now
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void enable()}
          className="border border-primary/50 px-4 py-1 font-mono text-11 font-black uppercase text-primary disabled:opacity-40"
        >
          Enable
        </button>
      </div>
    </div>
  );
}
