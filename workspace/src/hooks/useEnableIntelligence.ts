import { useCallback, useState } from "react";
import { setOntologyEnabled as setOntologyEnabledNative } from "@bridge/nativeClient";
import { getDefaultStrategy } from "../lib/prefs";
import { REMOTE_RESCAN_HINT, capabilitiesForSource } from "../lib/sourceCapabilities";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { useWorkspace } from "../state/workspaceStore";

/**
 * Turn the analysis on or off for the active index.
 *
 * On: flip the flag, then hand enrichment to the scan job:
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
    // The enable hands the work to a rescan, and a rescan here walks THIS PC — which for an
    // index of another machine would index our copy of that path under the remote's name.
    if (!capabilitiesForSource(activeEntry?.source).mutate) {
      setError(REMOTE_RESCAN_HINT);
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

  /**
   * The opt-out: "just show me sizes". No rescan — the index keeps everything it
   * already learned, the views simply stop claiming anything about safety. Turning
   * it back on re-uses `enable` above, which does trigger the incremental rescan.
   */
  const disable = useCallback(async () => {
    if (!indexPath || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setOntologyEnabledNative(indexPath, false);
      await refreshData();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [indexPath, busy, refreshData]);

  return { enable, disable, busy, error, enabled: ontologyEnabled };
}
