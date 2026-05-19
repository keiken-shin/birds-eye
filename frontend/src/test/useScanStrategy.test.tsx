import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useScan } from "../hooks/useScan";
import type { NativeIndexEntry } from "../nativeClient";

const chooseNativeFolder = vi.fn();
const startNativeScan = vi.fn();

vi.mock("../nativeClient", async () => {
  const actual = await vi.importActual<typeof import("../nativeClient")>("../nativeClient");
  return {
    ...actual,
    chooseNativeFolder: (...args: unknown[]) => chooseNativeFolder(...args),
    startNativeScan: (...args: unknown[]) => startNativeScan(...args),
    nativeJobEvents: vi.fn(() => Promise.resolve([])),
    listenNativeJobEvents: vi.fn(() => Promise.resolve(() => {})),
    queryNativeIndex: vi.fn(() =>
      Promise.resolve({
        folders: [],
        files: [],
        extensions: [],
        duplicate_groups: [],
        media: [],
        folder_media: [],
      })
    ),
  };
});

function renderUseScan(scanStrategy: "xxh3-progressive" | "fnv1a-legacy" = "xxh3-progressive") {
  return renderHook(() =>
    useScan({
      nativeRuntime: true,
      setRuntimeMessage: vi.fn(),
      refreshSavedIndexes: vi.fn(() => Promise.resolve()),
      scanStrategy,
    })
  );
}

describe("useScan strategy routing", () => {
  beforeEach(() => {
    chooseNativeFolder.mockReset();
    startNativeScan.mockReset();
    startNativeScan.mockResolvedValue({ jobId: 7, indexPath: "index.sqlite" });
  });

  it("uses the current preference for new native scans", async () => {
    chooseNativeFolder.mockResolvedValue("D:\\Data");
    const { result } = renderUseScan("fnv1a-legacy");

    await act(async () => {
      result.current.openFolderPicker();
    });

    expect(startNativeScan).toHaveBeenCalledWith("D:\\Data", "fnv1a-legacy");
  });

  it("uses the saved index strategy for rescans", async () => {
    const { result } = renderUseScan("xxh3-progressive");
    const entry: NativeIndexEntry = {
      index_path: "index.sqlite",
      root_path: "D:\\Data",
      last_status: "Completed",
      last_scanned_at: null,
      files_scanned: 1,
      folders_scanned: 1,
      bytes_scanned: 10,
      scan_strategy: "fnv1a-legacy",
    };

    await act(async () => {
      await result.current.rescanSavedIndex(entry);
    });

    expect(startNativeScan).toHaveBeenCalledWith("D:\\Data", "fnv1a-legacy");
  });
});
