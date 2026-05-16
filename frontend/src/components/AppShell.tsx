import { Outlet } from "react-router-dom";
import { BottomRail } from "./BottomRail";

export function AppShell() {
  return (
    <main className="relative block min-h-screen overflow-x-hidden bg-[#050607] bg-[radial-gradient(circle,rgba(255,255,255,0.13)_1px,transparent_1.3px)] bg-[length:24px_24px] text-[#f4f1ea] before:pointer-events-none before:absolute before:bottom-0 before:right-0 before:h-[40rem] before:w-[40rem] before:bg-[radial-gradient(circle_at_82%_82%,rgba(244,241,234,0.10),transparent_22rem)]">
      <Outlet />
      <BottomRail />
    </main>
  );
}
