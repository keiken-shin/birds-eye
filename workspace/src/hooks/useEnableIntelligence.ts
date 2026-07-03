import { useCallback, useState } from "react";
import {
  runOntologyEnrichment,
  setOntologyEnabled as setOntologyEnabledNative,
  type NativeEnrichmentBudget,
} from "@bridge/nativeClient";
import { useIndexData } from "../state/indexData";
import { useWorkspace } from "../state/workspaceStore";

/**
 * Enable cleanup intelligence for the active index, then run enrichment so verdicts /
 * reclaimable / related actually populate, then refresh. Shared by the Inspector CTA and
 * the EnableIntelligence prompt so there is one source of truth for the opt-in flow.
 */
export function useEnableIntelligence() {
  const { indexPath, ontologyEnabled } = useWorkspace();
  const { refreshData } = useIndexData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = useCallback(
    async (budget: NativeEnrichmentBudget = "standard") => {
      if (!indexPath || busy) return;
      setBusy(true);
      setError(null);
      try {
        // No optimistic flip: `ontologyEnabled` is only turned on by refreshData's confirmed
        // status read at the end, so a failure in enable OR enrichment leaves the prompt up
        // with its error visible instead of silently unmounting it. `busy` covers the spinner.
        await setOntologyEnabledNative(indexPath, true);
        await runOntologyEnrichment(indexPath, budget);
        await refreshData();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [indexPath, busy, refreshData]
  );

  return { enable, busy, error, enabled: ontologyEnabled };
}
