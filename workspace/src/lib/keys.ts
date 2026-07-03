/** Platform detection for shortcut labels — handlers accept both Ctrl and ⌘ everywhere. */
export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The modifier prefix for display ("⌘" on macOS, "Ctrl+" elsewhere). */
export const MOD = isMac ? "⌘" : "Ctrl+";
