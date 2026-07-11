import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { listSavedViews, type NativeSavedView } from "@bridge/nativeClient";
import { formatBytes } from "@bridge/domain";
import { useWorkspace } from "../state/workspaceStore";
import { useIndexData } from "../state/indexData";
import { useScanController } from "../state/scanController";
import { parseIntent } from "../lib/intent";
import { STAGE_VIEWS } from "../lib/viewRegistry";
import { isMac } from "../lib/keys";
import { Kbd } from "./ui/Chip";

/**
 * The command spine: the ask-input plus the one stage-view switcher. Typing a
 * line and pressing Enter routes through `parseIntent` — view names flip the
 * stage, keyword lines open the matching curated view, anything else runs a
 * literal file search on the Files view.
 */
export function CommandSpine() {
  const { runQuery, view, setView, pinned } = useWorkspace();
  const { ontology } = useIndexData();
  const scan = useScanController();
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const views = useRef<NativeSavedView[]>([]);

  useEffect(() => {
    void listSavedViews().then((v) => (views.current = v)).catch(() => {});
  }, []);

  // ⌘K / Ctrl-K focuses the command line from anywhere.
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
    if (!intent) return;
    if (intent.kind === "stage") setView(intent.view);
    else runQuery(intent);
    setText("");
    inputRef.current?.blur();
  };

  const running = scan.view.status === "scanning" ? scan.view : null;
  const boardBadge = (ontology?.pending_discoveries ?? 0) + pinned.length;

  return (
    <div className="flex h-[54px] flex-none items-center gap-3 border-b border-line bg-bar px-3.5">
      <div
        className="flex h-[36px] min-w-0 flex-1 items-center gap-2.5 rounded-[9px] border bg-field px-3.5 transition-colors"
        style={{ borderColor: focused ? "var(--color-primary-edge)" : "var(--color-line-input)" }}
      >
        <ChevronRight size={14} className="flex-none text-primary" aria-hidden />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder='Ask your storage — try "duplicates" · "old files" · "cleanup" · or search anything'
          spellCheck={false}
          aria-label="Command"
          className="min-w-0 flex-1 bg-transparent text-135 text-ink outline-none placeholder:text-dim"
        />
        <Kbd>{isMac ? "⌘K" : "Ctrl+K"}</Kbd>
      </div>

      {running ? (
        <button
          type="button"
          onClick={() => setView("scans")}
          className="mono flex flex-none items-center gap-2 rounded-full border border-primary-edge bg-primary-wash px-3 py-1.5 text-11 text-primary-ink transition-colors hover:brightness-125"
          title="Scan running — open Scans"
        >
          <Loader2 size={12} className="animate-spin" aria-hidden />
          Scanning · {formatBytes(running.bytes)}
        </button>
      ) : null}

      {/* The one stage switcher: active segment shows its label, the rest are
          icons with hover tooltips. */}
      <div
        role="tablist"
        aria-label="Stage view"
        className="flex flex-none gap-[2px] rounded-[9px] border border-line-input bg-field p-[3px]"
      >
        {STAGE_VIEWS.map((item) => {
          const active = view === item.view;
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              type="button"
              role="tab"
              aria-selected={active}
              title={`${item.label} (${item.key})`}
              onClick={() => setView(item.view)}
              className={`relative flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-11 font-medium transition-colors ${
                active ? "bg-primary text-on-primary" : "text-faint hover:bg-inset hover:text-ink"
              }`}
            >
              <Icon size={14} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
              {active ? <span>{item.label}</span> : null}
              {item.view === "board" && boardBadge > 0 && !active ? (
                <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
