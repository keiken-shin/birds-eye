# Working safely

Deleting files is easy to make fast and hard to make *safe*. Bird's Eye optimizes for the
second. The design principle is simple: **reversibility beats confirmation dialogs.** You
shouldn't have to be certain before you act — you should be able to undo.

## Nothing moves without review

There is exactly one path from the workspace to your disk:

```
Cleanup Tray  →  Review gate  →  OS Recycle Bin
```

You stage candidates from any view into the Tray. When you're ready, the **Review gate**
re-verifies the batch against the current index — sizes, verdicts, and paths — and shows
you precisely what will happen. Only after you confirm does anything move. No view has a
shortcut around this gate.

## Everything is reversible

- **Recycle Bin first, always.** Cleaned items go to the OS Recycle Bin with a tracked
  entry, not to oblivion.
- **Restorable for 30 days** from **Recently cleaned**, or reverted instantly with
  **Undo** right after the action.
- **Move instead of delete.** Sometimes the right answer isn't deletion — it's putting a
  file somewhere sensible. Bird's Eye can relocate it and then **heal the index** with a
  background rescan, so your map stays accurate.

## Verdicts, and what they mean

Every candidate carries a verdict, and every verdict is shown with its **size**, its
**staleness**, and a **reason** — never a bare recommendation.

| Verdict | Meaning |
|---|---|
| <span class="be-chip be-chip--safe">safe</span> | Regenerable or clearly disposable — caches, build output, installer leftovers. |
| <span class="be-chip be-chip--review">review</span> | Probably fine, but worth a human glance before it goes. |
| <span class="be-chip be-chip--protected">protected</span> | Held back by the safety predicate — system-adjacent or depended-on. Shown, never hidden. |
| <span class="be-chip be-chip--keep">keep</span> | Active or important; not a cleanup candidate. |

## Held-back items are shown, not hidden

When the safety predicate holds something back, Bird's Eye does **not** silently drop it
from the list. It stays visible with its reason, and you retain the final say: an
explicit, clearly-marked **override** lets you remove it anyway. The app's job is to give
you the evidence, not to overrule you.

## The intelligence layer is honest

The classifications behind these verdicts come from the **opt-in, per-index intelligence
layer**. It's worth being precise about what it is and isn't:

- **Heuristic, on-device.** No machine learning, no cloud calls, no external services.
- **Transparent.** It shows the reasoning behind each verdict.
- **Never fabricated.** If it can't classify a folder, it says *unclassified* — it doesn't
  invent a purpose or a confidence it doesn't have.

## Anti-scareware, on purpose

Bird's Eye will never nag you, never auto-delete, and never manufacture urgency to push a
"clean now" button. It's a calm, quantified instrument: it tells you what's there, what it
thinks, and why — and then it waits for you.
