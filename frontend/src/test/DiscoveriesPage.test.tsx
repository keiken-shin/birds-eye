import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { DiscoveriesPage } from "../pages/DiscoveriesPage";

vi.mock("../context/ScanContext", () => ({
  useScanContext: () => ({ workspaceIndexPath: "/idx.sqlite", setRuntimeMessage: vi.fn() }),
}));

vi.mock("../nativeClient", async () => {
  const actual = await vi.importActual<typeof import("../nativeClient")>("../nativeClient");
  return {
    ...actual,
    listDiscoveries: vi.fn(async (_i: string, kind: string) =>
      kind === "derivedFrom-pattern"
        ? [
            {
              id: 1,
              kind: "derivedFrom-pattern",
              payload: JSON.stringify({ derivative_path: "/a/x_export.png", source_path: "/a/x.psd" }),
              status: "Pending",
              confidence: 0.85,
              potential_bytes_unlocked: 2048,
              created_at: 1,
              resolved_at: null,
            },
          ]
        : []
    ),
    confirmDiscovery: vi.fn(async () => {}),
    rejectDiscovery: vi.fn(async () => {}),
    confirmDiscoveryPattern: vi.fn(async () => 1),
    rejectDiscoveryPattern: vi.fn(async () => 1),
  };
});

describe("DiscoveriesPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders a derivedFrom group and confirms the pattern", async () => {
    const { confirmDiscoveryPattern } = await import("../nativeClient");
    render(<MemoryRouter><DiscoveriesPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Derived-from suggestions/i)).toBeInTheDocument());
    expect(screen.getByText(/x_export\.png/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /confirm all/i }));
    await waitFor(() =>
      expect(confirmDiscoveryPattern).toHaveBeenCalledWith("/idx.sqlite", "derivedFrom-pattern")
    );
  });
});
