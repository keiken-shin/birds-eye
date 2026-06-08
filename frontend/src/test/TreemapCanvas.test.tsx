import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { colorForFolder, TreemapCanvas, type TreemapLensMap } from "../components/TreemapCanvas";
import { emptyFolderCategories, type FolderStats } from "../domain";

const folder: FolderStats & { displayBytes: number } = {
  path: "/root/work",
  files: 2,
  bytes: 300,
  displayBytes: 300,
  categories: { ...emptyFolderCategories(), documents: 300 },
};

const lensData: TreemapLensMap = {
  "/root/work": {
    folder_path: "/root/work",
    role: "derivative",
    replaceability: "regenerable",
    lifecycle: "finished",
    cleanup_reason: "safe-derivative",
    reclaimable_bytes: 100,
  },
};

describe("TreemapCanvas lenses", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null);
  });

  it("renders lens selector and reports lens changes", async () => {
    const onLensChange = vi.fn();
    render(
      <TreemapCanvas
        folders={[folder]}
        lens="size"
        lensData={lensData}
        onLensChange={onLensChange}
      />
    );

    expect(screen.getByRole("button", { name: "Role" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reclaimable Mass" }));
    expect(onLensChange).toHaveBeenCalledWith("reclaimableMass");
  });

  it("maps ontology values to stable palette colors", () => {
    expect(colorForFolder(folder, "role", lensData)).toBe("#22c55e");
    expect(colorForFolder(folder, "replaceability", lensData)).toBe("#22c55e");
    expect(colorForFolder(folder, "lifecycle", lensData)).toBe("#16a34a");
    expect(colorForFolder(folder, "reclaimableMass", lensData)).toBe("#22c55e");
  });
});
