import { describe, expect, it, vi } from "vitest";
import { selectableProps } from "./selectable";

type KeyArgs = { key: string; target: unknown; currentTarget: unknown };

/** The parts of a React keyboard event this helper actually reads. */
function keyEvent({ key, target, currentTarget }: KeyArgs) {
  return {
    key,
    target,
    currentTarget,
    preventDefault: vi.fn(),
  };
}

describe("selectableProps", () => {
  it("gives a row the three things a keyboard needs: a role, a tab stop, a name", () => {
    const props = selectableProps(() => {}, "Inspect holiday.jpg");
    expect(props.role).toBe("button");
    expect(props.tabIndex).toBe(0);
    expect(props["aria-label"]).toBe("Inspect holiday.jpg");
  });

  it.each(["Enter", " "])("selects on %s", (key) => {
    const select = vi.fn();
    const row = {};
    const props = selectableProps(select, "row");
    const event = keyEvent({ key, target: row, currentTarget: row });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props.onKeyDown(event as any);
    expect(select).toHaveBeenCalledOnce();
    // Space scrolls the page otherwise, which is the opposite of selecting the
    // thing you were looking at.
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores every other key, so typing near a row does not select it", () => {
    const select = vi.fn();
    const row = {};
    const props = selectableProps(select, "row");
    for (const key of ["a", "Tab", "ArrowDown", "Escape", "Shift"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props.onKeyDown(keyEvent({ key, target: row, currentTarget: row }) as any);
    }
    expect(select).not.toHaveBeenCalled();
  });

  /**
   * These rows contain their own buttons — Stage, Keep this. Space on one of
   * those must press that button and nothing else, or every keyboard user
   * staging a file also changes what the inspector is showing.
   */
  it("leaves a key pressed on a control inside the row to that control", () => {
    const select = vi.fn();
    const row = {};
    const innerButton = {};
    const props = selectableProps(select, "row");
    const event = keyEvent({ key: " ", target: innerButton, currentTarget: row });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props.onKeyDown(event as any);
    expect(select).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
