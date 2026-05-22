import { beforeEach, describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

function RightPanelGroup() {
  return (
    <ResizablePanelGroup id="right-test">
      <ResizablePanel id="center" flex>
        <span>Center</span>
      </ResizablePanel>
      <ResizablePanelHandle rightPanelId="right" />
      <ResizablePanel id="right" defaultSize={220} minSize={120}>
        <span data-testid="right-content">Right</span>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

describe("ResizablePanelGroup", () => {
  beforeEach(() => {
    localStorage.clear();
  });

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

  it("right-side handle resizes the panel on its right", () => {
    render(<RightPanelGroup />);
    const rightPanel = screen.getByTestId("right-content").parentElement?.parentElement;
    expect(rightPanel).toHaveStyle({ width: "220px" });

    fireEvent.pointerDown(screen.getByRole("separator"), { clientX: 300 });
    fireEvent.pointerMove(window, { clientX: 260 });
    fireEvent.pointerUp(window);

    expect(rightPanel).toHaveStyle({ width: "260px" });
  });
});
