import { useWorkspace } from "../state/workspaceStore";
import { MOD, isMac } from "../lib/keys";
import { STAGE_VIEWS } from "../lib/viewRegistry";
import { OverlayShell } from "./ui/OverlayShell";
import { SectionLabel } from "./ui/Card";
import { Kbd } from "./ui/Chip";

type Row = { label: string; keys: string };

/** Derived from STAGE_VIEWS so the 1–7 bindings can never drift from the switcher. */
const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: "Views",
    rows: [
      ...STAGE_VIEWS.map((v) => ({ label: v.label, keys: v.key })),
      { label: "Up one level (treemap)", keys: isMac ? "⌫" : "Backspace" },
      { label: "Toggle inspector", keys: `${MOD}I` },
    ],
  },
  {
    title: "Command",
    rows: [{ label: "Focus command bar", keys: isMac ? "⌘K" : "Ctrl+K" }],
  },
  {
    title: "Board canvas",
    rows: [
      { label: "Marquee select", keys: "Shift+Drag" },
      { label: "Add / remove from selection", keys: "Shift+Click" },
      { label: "Select all cards", keys: `${MOD}A` },
      { label: "Nudge selection", keys: "Arrows" },
      { label: "Clear selection", keys: "Esc" },
    ],
  },
  {
    title: "Cleanup",
    rows: [
      { label: "Stage selection", keys: isMac ? "⇧↵" : "Shift+Enter" },
      { label: "Review & clean", keys: isMac ? "⌘↵" : "Ctrl+Enter" },
      { label: "Undo last clean", keys: `${MOD}Z` },
    ],
  },
  {
    title: "System",
    rows: [
      { label: "New scan", keys: `${MOD}N` },
      { label: "Recently cleaned", keys: `${MOD}L` },
      { label: "Settings", keys: `${MOD},` },
      { label: "Shortcuts", keys: "?" },
      { label: "Close overlay", keys: "Esc" },
    ],
  },
];

/** Shortcuts reference. Settings, Library, and Scans each have their own overlay component now. */
export function MiscOverlay() {
  const { overlay, setOverlay } = useWorkspace();
  if (overlay !== "shortcuts") return null;

  return (
    <OverlayShell title="Keyboard shortcuts" width={460} onClose={() => setOverlay(null)}>
      <div className="flex flex-col gap-4 p-4.5">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <SectionLabel className="mb-2">{group.title}</SectionLabel>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3">
                  <span className="text-12 text-ink-soft">{row.label}</span>
                  <Kbd>{row.keys}</Kbd>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </OverlayShell>
  );
}
