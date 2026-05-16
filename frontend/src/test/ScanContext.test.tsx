import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";

// Mock Tauri and hooks so tests run in jsdom
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => false }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ScanProvider, useScanContext } from "../context/ScanContext";

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(ScanProvider, null, children);
}

describe("ScanContext queue", () => {
  it("starts with empty queueItems", () => {
    const { result } = renderHook(() => useScanContext(), { wrapper });
    expect(result.current.queueItems).toEqual([]);
  });

  it("loadQueueItem does nothing for unknown id", () => {
    const { result } = renderHook(() => useScanContext(), { wrapper });
    act(() => {
      result.current.loadQueueItem("nonexistent-id");
    });
    expect(result.current.queueItems).toEqual([]);
  });
});
