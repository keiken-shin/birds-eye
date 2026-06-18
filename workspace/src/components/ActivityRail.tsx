import { useWorkspace } from "../state/workspaceStore";

type RailButton = { glyph: string; title: string; onClick: () => void; active?: boolean };

export function ActivityRail() {
  const { lens, setLens, setOverlay } = useWorkspace();

  const top: RailButton[] = [
    { glyph: "▦", title: "Map", onClick: () => setLens("treemap"), active: lens === "treemap" },
    { glyph: "◎", title: "New scan (⌘N)", onClick: () => setOverlay("scan") },
    { glyph: "✦", title: "Findings", onClick: () => setLens("board"), active: lens === "board" },
    { glyph: "◷", title: "Library (⌘L)", onClick: () => setOverlay("library") },
  ];

  return (
    <div className="flex w-[54px] flex-none flex-col items-center gap-[5px] border-r border-line bg-panel pt-3">
      {top.map((b) => (
        <button
          key={b.title}
          type="button"
          title={b.title}
          onClick={b.onClick}
          className={
            "flex h-[38px] w-[38px] items-center justify-center rounded-[9px] text-[15px] " +
            (b.active
              ? "border border-primary/30 bg-primary/[0.13] text-primary"
              : "text-faint hover:text-ink")
          }
        >
          {b.glyph}
        </button>
      ))}
      <button
        type="button"
        title="Shortcuts (?)"
        onClick={() => setOverlay("shortcuts")}
        className="mt-auto flex h-[38px] w-[38px] items-center justify-center rounded-[9px] text-[14px] text-faint hover:text-ink"
      >
        ?
      </button>
      <button
        type="button"
        title="Settings (⌘,)"
        onClick={() => setOverlay("settings")}
        className="mb-3 flex h-[38px] w-[38px] items-center justify-center rounded-[9px] text-[15px] text-faint hover:text-ink"
      >
        ⚙
      </button>
    </div>
  );
}
