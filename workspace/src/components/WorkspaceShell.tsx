import { useEffect } from "react";
import { useWorkspace } from "../state/workspaceStore";
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
import { ScanQueueOverlay } from "./ScanQueueOverlay";
import { DuplicatesOverlay } from "./DuplicatesOverlay";
import { ReviewModal } from "./ReviewModal";
import { UndoToast } from "./UndoToast";
import { EnableIntelligence } from "./EnableIntelligence";

export function WorkspaceShell() {
  const { setLens, setOverlay, openReview, review, overlay, closeReview, lens, scopePath, popScopeTo } =
    useWorkspace();

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
      if (mod && e.key === ",") {
        e.preventDefault();
        setOverlay("settings");
        return;
      }
      if (!mod && !e.altKey) {
        if (e.key === "?") setOverlay("shortcuts");
        else if (e.key === "1") setLens("treemap");
        else if (e.key === "2") setLens("board");
        else if (e.key === "3") setLens("results");
        else if (e.key === "Backspace" && lens === "treemap" && scopePath.length) {
          e.preventDefault();
          popScopeTo(scopePath.length - 1);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [review, overlay, setLens, setOverlay, openReview, closeReview, lens, scopePath, popScopeTo]);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-base text-ink">
      <TitleBar />
      <CommandSpine />
      <div className="flex min-h-0 flex-1">
        <ActivityRail />
        <ScopeTree />
        <CenterStage />
        <Inspector />
      </div>
      <CleanupTray />

      <ScanOverlay />
      <MiscOverlay />
      <SettingsOverlay />
      <LibraryOverlay />
      <ScanQueueOverlay />
      <DuplicatesOverlay />
      <ReviewModal />
      <UndoToast />
      <EnableIntelligence />
    </div>
  );
}
