import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigDropdown } from "../components/ConfigDropdown";

describe("ConfigDropdown", () => {
  it("renders Smart Dedup as active when scanStrategy is smart", async () => {
    const onScanStrategyChange = vi.fn();
    render(
      <ConfigDropdown scanStrategy="smart" onScanStrategyChange={onScanStrategyChange}>
        <button type="button">Open</button>
      </ConfigDropdown>
    );

    await userEvent.click(screen.getByRole("button", { name: /open/i }));

    expect(screen.getByRole("button", { name: /smart dedup/i })).toBeInTheDocument();
  });

  it("calls onScanStrategyChange with 'metadata' when Metadata Only is clicked", async () => {
    const onScanStrategyChange = vi.fn();
    render(
      <ConfigDropdown scanStrategy="smart" onScanStrategyChange={onScanStrategyChange}>
        <button type="button">Open</button>
      </ConfigDropdown>
    );

    await userEvent.click(screen.getByRole("button", { name: /open/i }));
    await userEvent.click(screen.getByRole("button", { name: /metadata only/i }));

    expect(onScanStrategyChange).toHaveBeenCalledWith("metadata");
  });
});
