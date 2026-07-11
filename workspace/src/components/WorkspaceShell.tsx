import { useEffect } from "react";
import { useWorkspace } from "../state/workspaceStore";
import { STAGE_VIEWS } from "../lib/viewRegistry";
import { TitleBar } from "./TitleBar";
import { CommandSpine } from "./CommandSpine";
import { ActivityRail } from "./ActivityRail";
import { ScopeTree } from "./ScopeTree";
import { CenterStage } from "./CenterStage";
import { Inspector } from "./Inspector";
import { CleanupTray } from "./CleanupTray";
import { ScanOverlay } from "./ScanOverlay";
import { MiscOverlay } from "./MiscOverlay";
import { SettingsOverlay } from "./SettingsOverlay";
import { LibraryOverlay } from "./LibraryOverlay";
import { ReviewModal } from "./ReviewModal";
import { UndoToast } from "./UndoToast";
import { EnableIntelligence } from "./EnableIntelligence";
import { SidePanel, usePanelState } from "./ui/SidePanel";

export function WorkspaceShell() {
  const { setView, setOverlay, openReview, review, overlay, closeReview, view, scopePath, popScopeTo } =
    useWorkspace();

  const scope = usePanelState("be.ws.panel.scope", 230);
  const inspector = usePanelState("be.ws.panel.inspector", 316);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      const typing = tag === "INPUT" || tag === "TEXTAREA";

      if (e.key === "Escape") {
        if (review) closeReview();
        else if (overlay) setOverlay(null);
        return;
      }
      if (typing) return;

      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "Enter") {
        e.preventDefault();
        openReview();
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setOverlay("scan");
        return;
      }
      if (mod && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setOverlay("library");
        return;
      }
      if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        inspector.setCollapsed((c) => !c);
        return;
      }
      if (mod && e.key === ",") {
        e.preventDefault();
        setOverlay("settings");
        return;
      }
      if (!mod && !e.altKey) {
        if (e.key === "?") {
          setOverlay("shortcuts");
          return;
        }
        const stageView = STAGE_VIEWS.find((r) => r.key === e.key);
        if (stageView) {
          setView(stageView.view);
          return;
        }
        if (e.key === "Backspace" && view === "treemap" && scopePath.length) {
          e.preventDefault();
          popScopeTo(scopePath.length - 1);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [review, overlay, setView, setOverlay, openReview, closeReview, view, scopePath, popScopeTo, inspector]);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-base text-ink">
      <TitleBar />
      <CommandSpine />
      <div className="flex min-h-0 flex-1">
        <ActivityRail />
        <SidePanel
          side="left"
          label="scope tree"
          width={scope.width}
          onWidth={scope.setWidth}
          collapsed={scope.collapsed}
          onToggle={() => scope.setCollapsed((c) => !c)}
        >
          <ScopeTree />
        </SidePanel>
        <CenterStage />
        <SidePanel
          side="right"
          label="inspector"
          width={inspector.width}
          onWidth={inspector.setWidth}
          collapsed={inspector.collapsed}
          onToggle={() => inspector.setCollapsed((c) => !c)}
          max={520}
        >
          <Inspector />
        </SidePanel>
      </div>
      <CleanupTray />

      <ScanOverlay />
      <MiscOverlay />
      <SettingsOverlay />
      <LibraryOverlay />
      <ReviewModal />
      <UndoToast />
      <EnableIntelligence />
    </div>
  );
}
