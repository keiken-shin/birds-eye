/**
 * What the app may do with an index, given where its files actually live.
 *
 * A scan of another machine catalogs paths that exist over SSH and nowhere on
 * this PC — so anything that touches a file directly (reveal, preview, asking
 * Windows who has it open, cleanup, moves) has nothing to touch. Those entry
 * points are hidden rather than left to fail with an OS error.
 *
 * `source` is the index metadata's raw value: `"local"`, or the JSON blob the
 * backend writes for a remote session. Anything unrecognised is treated as
 * remote — the safe direction.
 */
export interface SourceCapabilities {
  reveal: boolean;
  lockHolders: boolean;
  preview: boolean;
  mutate: boolean;
}

export function capabilitiesForSource(source: string | undefined): SourceCapabilities {
  // undefined = an index scanned before the backend recorded a source: local.
  const onThisPc = source === undefined || source === "local";
  return { reveal: onThisPc, lockHolders: onThisPc, preview: onThisPc, mutate: onThisPc };
}

/** Why an action is unavailable — the tooltip on every gated entry point. */
export const REMOTE_ACTION_HINT =
  "This scan is of another machine — Bird's Eye can only do this for files on this PC.";
