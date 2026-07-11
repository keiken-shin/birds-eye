import { describe, expect, it } from "vitest";
import type { NativeDiscovery } from "@bridge/nativeClient";
import { baseName, parseFinding } from "./discoveries";

const disc = (over: Partial<NativeDiscovery> = {}): NativeDiscovery => ({
  id: 1,
  kind: "derivedFrom-pattern",
  payload: JSON.stringify({ derivative_path: "/a/x_export.png", source_path: "/a/x.psd" }),
  status: "Pending",
  confidence: 0.9,
  potential_bytes_unlocked: 2048,
  created_at: 0,
  resolved_at: null,
  ...over,
});

describe("parseFinding", () => {
  it("derivedFrom-pattern → subject=derivative, object=source", () => {
    const f = parseFinding(disc())!;
    expect(f.subject).toBe("/a/x_export.png");
    expect(f.object).toBe("/a/x.psd");
    expect(f.predicate).toBe("derived from");
    expect(f.bytes).toBe(2048);
  });

  it("backupOf-pair → subject=backup, object=origin", () => {
    const f = parseFinding(
      disc({
        kind: "backupOf-pair",
        payload: JSON.stringify({ backup_path: "/b/db.bak", origin_path: "/b/db.sqlite" }),
      })
    )!;
    expect(f.subject).toBe("/b/db.bak");
    expect(f.object).toBe("/b/db.sqlite");
    expect(f.predicate).toBe("backup of");
  });

  it("returns null on malformed payload or unknown kind", () => {
    expect(parseFinding(disc({ payload: "not json" }))).toBeNull();
    expect(parseFinding(disc({ kind: "mystery" }))).toBeNull();
    expect(parseFinding(disc({ payload: JSON.stringify({ derivative_path: "/a" }) }))).toBeNull();
  });
});

describe("baseName", () => {
  it("handles / and \\ and a trailing separator", () => {
    expect(baseName("/a/b/c.png")).toBe("c.png");
    expect(baseName("C:\\a\\b\\file.txt")).toBe("file.txt");
    expect(baseName("/a/b/")).toBe("b");
  });
});
