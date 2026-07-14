import { useCallback, useState } from "react";
import { setOntologyEnabled as setOntologyEnabledNative } from "@bridge/nativeClient";
import { getDefaultStrategy } from "../lib/prefs";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";

/**
 * Enable cleanup intelligence for the active index, then hand enrichment to the scan job:
 * an incremental rescan re-walks only what changed and its phase 2 runs the (cheap-budget)
 * enrichment on a background thread with live progress in the scan queue overlay.
 * The old path — awaiting `run_ontology_enrichment` inline — read file metadata for the
 * whole drive with zero feedback; on a real index that is 10+ minutes of a button
 * saying "Enriching…". Shared by the Inspector CTA and the EnableIntelligence prompt.
 */
export function useEnableIntelligence() {
  const { indexPath, ontologyEnabled, setView } = useWorkspace();
  const { refreshData, activeEntry } = useIndexData();
  const { enqueue } = useScanController();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = useCallback(async () => {
    if (!indexPath || busy) return;
    const root = activeEntry?.root_path;
    if (!root) {
      setError("No scan root recorded for this index — run a new scan instead.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setOntologyEnabledNative(indexPath, true);
      // Confirmed enable flips the prompt away via refreshData's status read; verdicts
      // stream in when the job's enrichment phase lands and onComplete refreshes again.
      await refreshData();
      enqueue(root, getDefaultStrategy(), true);
      setView("scans");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [indexPath, busy, activeEntry, refreshData, enqueue, setView]);

  return { enable, busy, error, enabled: ontologyEnabled };
}
