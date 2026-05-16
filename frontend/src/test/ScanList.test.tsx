import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ScanProvider } from "../context/ScanContext";
import { ScanList } from "../components/ScanList";

function renderInContext(selectedId?: string) {
  return render(
    <ScanProvider>
      <MemoryRouter initialEntries={[selectedId ? `/scan/${selectedId}` : "/scan"]}>
        <Routes>
          <Route path="/scan" element={<ScanList selectedId={undefined} />} />
          <Route path="/scan/:id" element={<ScanList selectedId={selectedId} />} />
        </Routes>
      </MemoryRouter>
    </ScanProvider>
  );
}

describe("ScanList", () => {
  it("shows empty state when no queue items", () => {
    renderInContext();
    expect(screen.getByText(/no scans yet/i)).toBeInTheDocument();
  });

  it("shows start scan link in empty state", () => {
    renderInContext();
    const link = screen.getByRole("link", { name: /start scan/i });
    expect(link).toBeInTheDocument();
  });
});
