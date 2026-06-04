import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { CleanupPage } from "../pages/CleanupPage";

vi.mock("../context/ScanContext", () => ({
  useScanContext: () => ({ workspaceIndexPath: "/idx.sqlite", setRuntimeMessage: vi.fn() }),
}));

vi.mock("../nativeClient", async () => {
  const actual = await vi.importActual<typeof import("../nativeClient")>("../nativeClient");
  return {
    ...actual,
    buildCleanupPlan: vi.fn(async () => ({
      plan_id: 7,
      total_files: 1,
      total_bytes: 2048,
      candidates: [
        { file_id: 2, entity_id: 9, path: "/a/List_export.png", size: 2048, reason: "safe-derivative" },
      ],
    })),
    executeCleanupPlan: vi.fn(async () => ({ plan_id: 7, cleaned: 1, bytes_cleaned: 2048, failed: [] })),
  };
});

vi.mock("../components/FileProvenance", () => ({ FileProvenance: () => <div>prov</div> }));

describe("CleanupPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads candidates grouped by reason and executes", async () => {
    const { buildCleanupPlan, executeCleanupPlan } = await import("../nativeClient");
    render(<MemoryRouter><CleanupPage /></MemoryRouter>);

    await userEvent.click(screen.getByRole("button", { name: /build plan/i }));
    await waitFor(() => expect(buildCleanupPlan).toHaveBeenCalled());
    expect(screen.getAllByText(/Safe derivative/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/List_export\.png/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /recycle 1 file/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(executeCleanupPlan).toHaveBeenCalledWith("/idx.sqlite", 7, undefined));
    expect(screen.getByText(/cleaned 1 file/i)).toBeInTheDocument();
  });
});
