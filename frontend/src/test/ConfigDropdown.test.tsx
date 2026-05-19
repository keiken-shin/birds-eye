import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfigDropdown } from "../components/ConfigDropdown";

describe("ConfigDropdown", () => {
  it("calls onScanStrategyChange when a strategy is selected", async () => {
    const onScanStrategyChange = vi.fn();
    render(
      <ConfigDropdown scanStrategy="xxh3-progressive" onScanStrategyChange={onScanStrategyChange}>
        <button type="button">Open</button>
      </ConfigDropdown>
    );

    await userEvent.click(screen.getByRole("button", { name: /open/i }));
    await userEvent.click(screen.getByRole("button", { name: /legacy fnv-1a/i }));

    expect(onScanStrategyChange).toHaveBeenCalledWith("fnv1a-legacy");
  });
});
