import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizablePanelHandle,
} from "../components/ResizablePanel";

function TestGroup() {
  return (
    <ResizablePanelGroup id="test">
      <ResizablePanel id="left" defaultSize={200} minSize={100} collapsible>
        <span data-testid="left-content">Left</span>
      </ResizablePanel>
      <ResizablePanelHandle leftPanelId="left" />
      <ResizablePanel id="center" flex>
        <span data-testid="center-content">Center</span>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

describe("ResizablePanelGroup", () => {
  it("renders children", () => {
    render(<TestGroup />);
    expect(screen.getByTestId("left-content")).toBeInTheDocument();
    expect(screen.getByTestId("center-content")).toBeInTheDocument();
  });

  it("flex panel has flex-1 class", () => {
    render(<TestGroup />);
    const centerContent = screen.getByTestId("center-content");
    expect(centerContent.parentElement).toHaveClass("flex-1");
  });

  it("renders a separator handle", () => {
    render(<TestGroup />);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });
});
