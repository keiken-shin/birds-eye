import { useCallback, useEffect, useState } from "react";
import { ontologyStatus, type NativeOntologyStatus } from "../nativeClient";

export function useOntologyStatus(indexPath: string | null) {
  const [status, setStatus] = useState<NativeOntologyStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!indexPath) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await ontologyStatus(indexPath));
    } catch {
      setStatus(null);
    }
  }, [indexPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, refresh };
}
