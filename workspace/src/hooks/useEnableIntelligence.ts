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
  const { indexPath, ontologyEnabled, setOntologyEnabled } = useWorkspace();
  const { refreshData } = useIndexData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = useCallback(
    async (budget: NativeEnrichmentBudget = "standard") => {
      if (!indexPath || busy) return;
      setBusy(true);
      setError(null);
      try {
        await setOntologyEnabledNative(indexPath, true);
        setOntologyEnabled(true);
        await runOntologyEnrichment(indexPath, budget);
        await refreshData();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [indexPath, busy, refreshData, setOntologyEnabled]
  );

  return { enable, busy, error, enabled: ontologyEnabled };
}
