import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { ScanLog } from "../components/ScanLog";
import type { ScanLogEntry } from "../domain";

const entries: ScanLogEntry[] = [
  { ts: Date.now(), level: "info", message: "scan started" },
  { ts: Date.now(), level: "warn", message: "symlink skipped" },
  { ts: Date.now(), level: "error", message: "access denied" },
];

describe("ScanLog", () => {
  it("renders all log entries", () => {
    render(<ScanLog entries={entries} isActive={false} />);
    expect(screen.getByText("scan started")).toBeInTheDocument();
    expect(screen.getByText("symlink skipped")).toBeInTheDocument();
    expect(screen.getByText("access denied")).toBeInTheDocument();
  });

  it("shows empty state when no entries", () => {
    render(<ScanLog entries={[]} isActive={false} />);
    expect(screen.getByText(/no log entries/i)).toBeInTheDocument();
  });

  it("renders phase label when entry has a phase", () => {
    const withPhase: ScanLogEntry[] = [
      { ts: Date.now(), level: "info", message: "dir scanned", phase: "scan" },
    ];
    render(<ScanLog entries={withPhase} isActive={false} />);
    expect(screen.getByText("scan")).toBeInTheDocument();
    expect(screen.getByText("dir scanned")).toBeInTheDocument();
  });

  it("renders timing matrix block for isTimingMatrix entries", () => {
    const withMatrix: ScanLogEntry[] = [
      {
        ts: Date.now(),
        level: "info",
        message: "── Time Breakdown\n  scan    2.1s\n  total   2.1s",
        isTimingMatrix: true,
      },
    ];
    render(<ScanLog entries={withMatrix} isActive={false} />);
    expect(screen.getByText(/Time Breakdown/)).toBeInTheDocument();
  });
});
