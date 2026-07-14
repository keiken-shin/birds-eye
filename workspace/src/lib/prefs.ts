import type { ScanStrategy } from "@bridge/domain";

/**
 * Local UI preferences. The backend has no settings store and these are honest UI-only defaults,
 * so localStorage is the right home (no dep, survives restarts). Currently one real preference:
 * which scan strategy a new scan starts on — a choice the app genuinely can't derive.
 */
const STRATEGY_KEY = "ws:defaultScanStrategy";
const INTELLIGENCE_KEY = "ws:defaultEnableIntelligence";

export function getDefaultStrategy(): ScanStrategy {
  return localStorage.getItem(STRATEGY_KEY) === "metadata" ? "metadata" : "smart";
}

export function setDefaultStrategy(strategy: ScanStrategy): void {
  localStorage.setItem(STRATEGY_KEY, strategy);
}

/** First-time users start with intelligence ON; after that, their last choice sticks. */
export function getDefaultEnableIntelligence(): boolean {
  return localStorage.getItem(INTELLIGENCE_KEY) !== "0";
}

export function setDefaultEnableIntelligence(on: boolean): void {
  localStorage.setItem(INTELLIGENCE_KEY, on ? "1" : "0");
}
