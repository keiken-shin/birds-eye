import { describe, expect, it } from "vitest";
import { parseIntent } from "./intent";
import type { NativeSavedView } from "@bridge/nativeClient";

const VIEWS: NativeSavedView[] = [
  { id: "regenerable-large", name: "Regenerable derivatives over 100 MB", description: "", protective: false },
  { id: "unclassified", name: "Files with no classification yet", description: "", protective: false },
  { id: "finished-untouched", name: "Finished projects untouched 1+ year", description: "", protective: false },
  { id: "orphan-backups", name: "Backups whose origin no longer exists", description: "", protective: true },
];

describe("parseIntent", () => {
  it("returns null for empty input", () => {
    expect(parseIntent("   ", VIEWS)).toBeNull();
  });

  it("routes keyword lines to the matching curated view", () => {
    expect(parseIntent("show me old files", VIEWS)).toEqual({
      kind: "view",
      viewId: "finished-untouched",
      viewName: "Finished projects untouched 1+ year",
    });
    expect(parseIntent("regenerable", VIEWS)).toMatchObject({ kind: "view", viewId: "regenerable-large" });
    expect(parseIntent("unclassified", VIEWS)).toMatchObject({ kind: "view", viewId: "unclassified" });
  });

  it("falls back to literal search for filenames (no whole-word hijack)", () => {
    expect(parseIntent("background.png", VIEWS)).toEqual({ kind: "search", text: "background.png" });
    expect(parseIntent("report 2024", VIEWS)).toEqual({ kind: "search", text: "report 2024" });
  });

  it("never routes to a view the backend doesn't offer", () => {
    // "orphan sources" view absent from this list → must search, not invent it.
    expect(parseIntent("orphan sources", VIEWS)).toEqual({ kind: "search", text: "orphan sources" });
  });
});
