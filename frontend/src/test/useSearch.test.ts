// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { useSearch } from "../hooks/useSearch";
import { invoke } from "@tauri-apps/api/core";
import { initialScanState } from "../domain";

describe("useSearch filter forwarding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls searchNativeIndex with filter params when nativeRuntime=true", async () => {
    const { result } = renderHook(() =>
      useSearch({
        currentIndexPath: "/fake/index.sqlite",
        nativeRuntime: true,
        largestFiles: initialScanState.largestFiles,
        setRuntimeMessage: () => {},
        filters: { kinds: ["photos"], minBytes: 1024 * 1024 },
      })
    );

    act(() => {
      result.current.setSearchQuery("sunset");
    });

    // Advance timers past the 180ms debounce
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    // CategoryKey "photos" maps to native media_kind "photo"
    expect(invoke).toHaveBeenCalledWith(
      "search_files",
      expect.objectContaining({
        request: expect.objectContaining({
          query: "sunset",
          kinds: ["photo"],
          min_bytes: 1024 * 1024,
        }),
      })
    );
  });

  it("does not call searchNativeIndex when query is less than 2 characters", async () => {
    renderHook(() =>
      useSearch({
        currentIndexPath: "/fake/index.sqlite",
        nativeRuntime: true,
        largestFiles: initialScanState.largestFiles,
        setRuntimeMessage: () => {},
        filters: {},
      })
    );

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    expect(invoke).not.toHaveBeenCalled();
  });
});
