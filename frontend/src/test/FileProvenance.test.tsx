import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FileProvenance } from "../components/FileProvenance";
import * as nativeClient from "../nativeClient";

vi.mock("../nativeClient", () => ({
  fileProvenance: vi.fn(async () => ({
    file_id: 2,
    path: "/a/List_export.png",
    is_pinned: false,
    attrs: [
      { key: "role", value: "derivative", source: "user", confidence: 1.0 },
      { key: "replaceability", value: "regenerable", source: "rule:x", confidence: 0.95 },
    ],
    relations: [
      { predicate: "derivedFrom", object_path: "/a/List.psd", source: "user", confidence: 1.0 },
    ],
  })),
  pinFile: vi.fn(async () => {}),
  unpinFile: vi.fn(async () => {}),
  overrideClassification: vi.fn(async () => {}),
}));

describe("FileProvenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the gating facts and the derivedFrom relation", async () => {
    render(<FileProvenance indexPath="/idx.sqlite" fileId={2} />);
    await waitFor(() => expect(screen.getAllByText(/derivative/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/regenerable/i)).toBeInTheDocument();
    expect(screen.getByText(/derivedFrom/i)).toBeInTheDocument();
    expect(screen.getByText(/List\.psd/)).toBeInTheDocument();
  });

  it("renders the error message when fileProvenance rejects", async () => {
    vi.mocked(nativeClient.fileProvenance).mockRejectedValueOnce(new Error("boom"));
    render(<FileProvenance indexPath="/idx.sqlite" fileId={2} />);
    await waitFor(() => expect(screen.getByText(/Provenance error/i)).toBeInTheDocument());
    expect(screen.getByText(/boom/i)).toBeInTheDocument();
  });
});
