import { describe, expect, it } from "vitest";
import type { NativeTreemapLensFolder } from "@bridge/nativeClient";
import {
  folderRecommendations,
  staleFileRecommendations,
  topRecommendations,
  untouchedFor,
  untouchedSince,
} from "./recommendations";

const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (d: number) => NOW - d * 86_400;

const row = (over: Partial<NativeTreemapLensFolder>): NativeTreemapLensFolder => ({
  folder_path: "C:\\r\\x",
  role: "scratch",
  replaceability: "regenerable",
  lifecycle: null,
  cleanup_reason: "scratch",
  reclaimable_bytes: 100,
  modified_at: null,
  ...over,
});

describe("age on a recommendation row", () => {
  it("gives the number, never a category", () => {
    expect(untouchedFor(240)).toBe("untouched 8 months");
    expect(untouchedFor(30)).toBe("untouched 1 month");
    expect(untouchedFor(401)).toBe("untouched 1.1 years");
  });

  it("reads out loud at every boundary", () => {
    // The landing row is the ad, and "untouched 1.0 years" is a machine talking.
    expect(untouchedFor(365)).toBe("untouched 1 year");
    expect(untouchedFor(370)).toBe("untouched 1 year");
    expect(untouchedFor(730)).toBe("untouched 2 years");
    expect(untouchedFor(3650)).toBe("untouched 10 years");
  });

  it("says nothing rather than inventing an age when there is no timestamp", () => {
    expect(untouchedSince(null)).toBeNull();
  });

  it("refuses a lost mtime (the 1980 FAT epoch) instead of claiming 46 years", () => {
    expect(untouchedSince(0)).toBeNull();
  });

  it("carries the folder's real age onto the row", () => {
    const [item] = folderRecommendations(
      [row({ modified_at: daysAgo(240) })],
      new Set(["scratch"]),
      "C:\\r"
    );
    expect(item.age).toBe("untouched 8 months");
  });

  it("keeps the row when the age is unknown", () => {
    const [item] = folderRecommendations([row({})], new Set(["scratch"]), "C:\\r");
    expect(item).toBeDefined();
    expect(item.age).toBeNull();
  });
});

describe("which folders make the list", () => {
  const rows = [
    row({ folder_path: "C:\\r", reclaimable_bytes: 900 }), // the scan root itself
    row({ folder_path: "C:\\r\\node_modules", reclaimable_bytes: 300 }),
    row({ folder_path: "C:\\r\\node_modules\\.cache", reclaimable_bytes: 50 }), // nested
    row({ folder_path: "C:\\r\\target", reclaimable_bytes: 500, cleanup_reason: "safe-derivative" }),
    row({ folder_path: "C:\\r\\empty", reclaimable_bytes: 0 }),
  ];

  it("drops the root, nested duplicates and zero-reclaim rows, biggest first", () => {
    expect(topRecommendations(rows, "C:\\r").map((r) => r.name)).toEqual([
      "target",
      "node_modules",
    ]);
  });

  it("filters by reason", () => {
    expect(folderRecommendations(rows, new Set(["safe-derivative"]), "C:\\r").map((r) => r.name)).toEqual(
      ["target"]
    );
  });
});

describe("stale files", () => {
  let nextId = 1;
  const file = (path: string, size: number, modified_at: number | null) => ({
    path,
    size,
    logical_size: size,
    extension: null,
    media_kind: "other",
    modified_at,
    file_id: nextId++,
  });

  it("keeps only what genuinely hasn't been touched in a year, biggest first", () => {
    const items = staleFileRecommendations([
      file("C:\\a.iso", 10, daysAgo(400)),
      file("C:\\b.iso", 99, daysAgo(30)), // recent
      file("C:\\c.iso", 50, daysAgo(800)),
      file("C:\\d.iso", 80, 0), // lost mtime — not "46 years old"
    ]);
    expect(items.map((i) => i.name)).toEqual(["c.iso", "a.iso"]);
    expect(items[0].age).toBe("untouched 2.2 years");
  });
});
