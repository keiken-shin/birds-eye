import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { SavedViewsPage } from "../pages/SavedViewsPage";

vi.mock("../context/ScanContext", () => ({
  useScanContext: () => ({ workspaceIndexPath: "/idx.sqlite", setRuntimeMessage: vi.fn() }),
}));

vi.mock("../nativeClient", async () => {
  const actual = await vi.importActual<typeof import("../nativeClient")>("../nativeClient");
  return {
    ...actual,
    listSavedViews: vi.fn(async () => [
      { id: "unclassified", name: "Files with no classification yet", description: "…", protective: false },
      { id: "orphan-backups", name: "Backups whose origin no longer exists", description: "…", protective: true },
    ]),
    runSavedView: vi.fn(async () => [{ file_id: 2, path: "/a/no_role.png", size: 20 }]),
  };
});

describe("SavedViewsPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists views and runs the selected one", async () => {
    const { runSavedView } = await import("../nativeClient");
    render(<MemoryRouter><SavedViewsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Files with no classification yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Files with no classification yet/i }));
    await waitFor(() => expect(runSavedView).toHaveBeenCalledWith("/idx.sqlite", "unclassified", undefined));
    expect(screen.getByText(/no_role\.png/)).toBeInTheDocument();
  });

  it("shows a protected banner for protective views", async () => {
    render(<MemoryRouter><SavedViewsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Backups whose origin/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Backups whose origin/i }));
    await waitFor(() => expect(screen.getAllByText(/Protected/i).length).toBeGreaterThan(0));
  });
});
