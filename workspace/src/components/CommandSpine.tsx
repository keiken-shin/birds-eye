import { useEffect, useRef, useState } from "react";
import { listSavedViews, type NativeSavedView } from "@bridge/nativeClient";
import { useWorkspace } from "../state/workspaceStore";
import { parseIntent } from "../lib/intent";
import type { Lens } from "../state/types";

const LENSES: Array<{ id: Lens; label: string }> = [
  { id: "treemap", label: "▦ Treemap" },
  { id: "board", label: "⬡ Board" },
  { id: "results", label: "▸ Results" },
];

/**
 * The command spine. The lens switcher and the query input are both live: typing a line and
 * pressing Enter routes through `parseIntent` — keyword lines ("old files", "unclassified")
 * open the matching curated view, anything else runs a literal file search — then drops you on
 * the Results lens. The lens's own search box stays literal, so nothing is unreachable.
 */
export function CommandSpine() {
  const { lens, setLens, runQuery } = useWorkspace();
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const views = useRef<NativeSavedView[]>([]);

  useEffect(() => {
    void listSavedViews().then((v) => (views.current = v)).catch(() => {});
  }, []);

  // ⌥⌘K / Ctrl-K focuses the command line from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const intent = parseIntent(text, views.current);
    if (intent) runQuery(intent);
  };

  return (
    <div className="flex h-[58px] flex-none items-center gap-3 border-b border-line bg-bar px-3.5">
      <div
        className="flex h-[38px] flex-1 items-center gap-2.5 rounded-[9px] border bg-field px-3.5 transition-colors"
        style={{ borderColor: focused ? "rgba(61,220,132,.5)" : "var(--color-line-input)" }}
      >
        <span className="text-[14px] text-primary">▸</span>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search files, or try “old files” · “unclassified” · “regenerable” →"
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
