import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../hooks/useSearch", () => ({
  useSearch: () => ({ searchQuery: "", setSearchQuery: vi.fn(), searchResults: [] }),
}));

import { CommandPalette } from "../components/CommandPalette";
import { initialScanState } from "../domain";

const props = {
  currentIndexPath: "/fake/index.sqlite",
  nativeRuntime: false,
  scan: initialScanState,
};

describe("CommandPalette", () => {
  it("is not visible by default", () => {
    render(<CommandPalette {...props} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on Ctrl+K and closes on Escape", () => {
    render(<CommandPalette {...props} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows filters toggle button when open", () => {
    render(<CommandPalette {...props} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTitle(/toggle filters/i)).toBeInTheDocument();
  });
});
