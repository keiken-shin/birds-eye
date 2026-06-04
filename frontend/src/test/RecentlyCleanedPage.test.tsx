import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { RecentlyCleanedPage } from "../pages/RecentlyCleanedPage";

vi.mock("../context/ScanContext", () => ({
  useScanContext: () => ({ workspaceIndexPath: "/idx.sqlite", setRuntimeMessage: vi.fn() }),
}));

vi.mock("../nativeClient", async () => {
  const actual = await vi.importActual<typeof import("../nativeClient")>("../nativeClient");
  return {
    ...actual,
    recentlyCleaned: vi.fn(async () => [
      { id: 1, cleanup_plan_id: 7, file_id: 2, original_path: "/a/List_export.png", size: 2048, cleaned_at: 1, reason: "safe-derivative", restore_status: "in_recycle_bin", expires_at: null },
      { id: 2, cleanup_plan_id: 7, file_id: 3, original_path: "/a/old.png", size: 1024, cleaned_at: 1, reason: "scratch", restore_status: "restored", expires_at: null },
    ]),
    restoreCleanupEntry: vi.fn(async () => {}),
  };
});

describe("RecentlyCleanedPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists entries and restores an in-bin entry", async () => {
    const { restoreCleanupEntry } = await import("../nativeClient");
    render(<MemoryRouter><RecentlyCleanedPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/List_export\.png/)).toBeInTheDocument());

    const restoreButtons = screen.getAllByRole("button", { name: /restore/i });
    expect(restoreButtons).toHaveLength(1); // only the in_recycle_bin entry is restorable
    await userEvent.click(restoreButtons[0]);
    await waitFor(() => expect(restoreCleanupEntry).toHaveBeenCalledWith("/idx.sqlite", 1));
  });
});
