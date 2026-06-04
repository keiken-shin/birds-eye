import { Outlet } from "react-router-dom";
import { BottomRail } from "./BottomRail";
import { ScanToast } from "./ScanToast";
import { OntologyEnablePrompt } from "./OntologyEnablePrompt";
import { useScanContext } from "../context/ScanContext";

export function AppShell() {
  const { workspaceIndexPath } = useScanContext();
  return (
    <main className="relative block min-h-screen overflow-x-hidden bg-base bg-[radial-gradient(circle,rgba(255,255,255,0.13)_1px,transparent_1.3px)] bg-[length:24px_24px] text-primary before:pointer-events-none before:absolute before:bottom-0 before:right-0 before:h-[40rem] before:w-[40rem] before:bg-[radial-gradient(circle_at_82%_82%,rgba(244,241,234,0.10),transparent_22rem)]">
      <Outlet />
      {workspaceIndexPath && <OntologyEnablePrompt indexPath={workspaceIndexPath} />}
      <BottomRail />
      <ScanToast />
    </main>
  );
}
