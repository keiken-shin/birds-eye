import { describe, expect, it } from "vitest";
import type { NativeTreemapLensFolder } from "@bridge/nativeClient";
import { buildFolderTree, scopeChildren, type FolderRow } from "./folderTree";
import { verdictForFolder } from "./verdict";

// Integration: the data path the Treemap lens + Inspector actually rely on —
// query_index folders → buildFolderTree → scopeChildren, joined to treemap_lens_data
// rows via lensByPath.get(node.path). The join is keyed on the raw folders.path string,
// so this guards that the key matches on BOTH separator styles (Windows back-slash matters).

function run(sep: "/" | "\\") {
  const root = `C:${sep}r`;
  const build = `C:${sep}r${sep}build`;
  const src = `C:${sep}r${sep}src`;

  const folders: FolderRow[] = [
    { path: root, total_files: 10, total_bytes: 300 },
    { path: build, total_files: 4, total_bytes: 200 },
    { path: src, total_files: 6, total_bytes: 100 },
  ];

  // Mirror exactly how indexData builds the lookup map.
  const lensRows: NativeTreemapLensFolder[] = [
    { folder_path: build, role: "derivative", replaceability: "regenerable", lifecycle: "finished", cleanup_reason: "safe-derivative", reclaimable_bytes: 180 },
    { folder_path: src, role: "source", replaceability: "irreplaceable", lifecycle: "active", cleanup_reason: null, reclaimable_bytes: 0 },
  ];
  const lensByPath = new Map(lensRows.map((r) => [r.folder_path, r]));

  const tree = buildFolderTree(folders, root);
  const children = scopeChildren(tree, []); // at root scope

  return { children, lensByPath };
}

describe("treemap data join (query_index ⋈ treemap_lens_data)", () => {
  for (const sep of ["/", "\\"] as const) {
    it(`builds children and attaches verdict/reclaimable with "${sep}" separators`, () => {
      const { children, lensByPath } = run(sep);

      // Tree resolved the root's children, sorted biggest-first.
      expect(children.map((c) => c.name)).toEqual(["build", "src"]);

      const byName = Object.fromEntries(children.map((c) => [c.name, c]));

      // The lens row is retrievable by node.path (the key invariant) and maps to a verdict.
      const buildRow = lensByPath.get(byName.build.path);
      const srcRow = lensByPath.get(byName.src.path);
      expect(buildRow).toBeDefined();
      expect(srcRow).toBeDefined();

      expect(verdictForFolder(buildRow!)).toBe("safe");
      expect(buildRow!.reclaimable_bytes).toBe(180);

      expect(verdictForFolder(srcRow!)).toBe("protected");
    });
  }
});
