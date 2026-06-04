import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OntologyEnablePrompt } from "../components/OntologyEnablePrompt";

const setOntologyEnabled = vi.fn(async (_path: string, _enabled: boolean) => {});

vi.mock("../nativeClient", () => ({
  ontologyStatus: vi.fn(async () => ({ enabled: false, pending_discoveries: 0 })),
  setOntologyEnabled: (...args: unknown[]) => setOntologyEnabled(...(args as [string, boolean])),
}));

describe("OntologyEnablePrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("offers to enable and calls the backend on accept", async () => {
    render(<OntologyEnablePrompt indexPath="/idx.sqlite" />);
    await waitFor(() => expect(screen.getByText(/Cleanup Intelligence/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /enable/i }));
    await waitFor(() => expect(setOntologyEnabled).toHaveBeenCalledWith("/idx.sqlite", true));
  });
});
