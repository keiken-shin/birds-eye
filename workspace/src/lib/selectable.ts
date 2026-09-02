import type { KeyboardEvent } from "react";

/**
 * Makes a row selectable by keyboard as well as by mouse.
 *
 * A `<div>` with an `onClick` is invisible to the keyboard and announces itself
 * to a screen reader as unlabelled text. The rows in Files, Duplicates, the
 * timeline and the map were all built that way, so the lists a person browses
 * most could only be operated with a pointer.
 *
 * Not a `<button>`, which is the usual answer, because these rows already
 * contain buttons of their own -- Stage, Keep this -- and a button inside a
 * button is invalid and behaves unpredictably. `role="button"` plus a tab stop
 * plus the two keys a button responds to is the same contract without the
 * nesting.
 *
 * The focus ring comes free: `index.css` draws one on anything `:focus-visible`.
 */
export function selectableProps(onSelect: () => void, label: string) {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: onSelect,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // A key pressed on a control inside the row belongs to that control.
      // Without this, Space on a Stage button would also select the row.
      if (event.target !== event.currentTarget) return;
      // Space scrolls the page otherwise, which is the opposite of selecting
      // the thing you were looking at.
      event.preventDefault();
      onSelect();
    },
  } as const;
}
