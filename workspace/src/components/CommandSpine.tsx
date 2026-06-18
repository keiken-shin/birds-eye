import { useState } from "react";
import { useWorkspace } from "../state/workspaceStore";
import type { Lens } from "../state/types";

const LENSES: Array<{ id: Lens; label: string }> = [
  { id: "treemap", label: "▦ Treemap" },
  { id: "board", label: "⬡ Board" },
  { id: "results", label: "▸ Results" },
];

/**
 * The command spine. Lens switcher is fully wired; the query input is intentionally inert
 * in v1 (routing deferred per plan) — it's a focusable placeholder so the spine reads true.
 */
export function CommandSpine() {
  const { lens, setLens } = useWorkspace();
  const [focused, setFocused] = useState(false);

  return (
    <div className="flex h-[58px] flex-none items-center gap-3 border-b border-line bg-bar px-3.5">
      <div
        className="flex h-[38px] flex-1 items-center gap-2.5 rounded-[9px] border bg-field px-3.5 transition-colors"
        style={{ borderColor: focused ? "rgba(61,220,132,.5)" : "var(--color-line-input)" }}
      >
        <span className="text-[14px] text-primary">▸</span>
        <input
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Ask your storage — coming soon (Treemap · Board · Results below)"
          spellCheck={false}
          className="flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-dim"
        />
        <span className="mono text-[10.5px] text-[#4b515a]">⌥⌘K</span>
      </div>
      <div className="flex flex-none gap-[2px] rounded-[9px] border border-line-input bg-field p-[3px]">
        {LENSES.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => setLens(l.id)}
            className="whitespace-nowrap rounded-[7px] px-3 py-1.5 text-12 font-medium transition-colors"
            style={{
              background: lens === l.id ? "var(--color-primary)" : "transparent",
              color: lens === l.id ? "var(--color-on-primary)" : "var(--color-muted)",
            }}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
