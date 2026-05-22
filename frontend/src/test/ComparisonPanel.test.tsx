// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparisonPanel } from "../components/ComparisonPanel";
import type { NativeDuplicateFile } from "../nativeClient";

vi.mock("../components/MediaPreview", () => ({
  MediaPreview: () => <div data-testid="media-preview" />,
}));

const files: NativeDuplicateFile[] = [
  { path: "/photos/current/file.jpg", size: 100, modified_at: 1000, hash_state: 4 },
  { path: "/photos/backup/file.jpg", size: 100, modified_at: 900, hash_state: 4 },
];

describe("ComparisonPanel", () => {
  it("uses a keyboard-focusable control for the hash confidence tooltip", () => {
    render(
      <ComparisonPanel
        files={files}
        cursor={0}
        setCursor={vi.fn()}
        staged={new Map()}
        stage={vi.fn()}
        unstage={vi.fn()}
        nativeRuntime={false}
      />
    );

    const triggers = screen.getAllByRole("button", { name: "Explain hash confidence" });
    expect(triggers).toHaveLength(2);
  });
});
