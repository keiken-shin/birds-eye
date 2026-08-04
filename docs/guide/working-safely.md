# Working safely

Deleting files is easy to make fast and hard to make *safe*. Bird's Eye is built for the second.
The principle behind it is simple: **being able to undo beats being asked "are you sure?"** You
shouldn't have to be certain before you act — you should be able to change your mind after.

## Nothing moves without review

There is exactly one path from the app to your disk, whichever kind of change you've staged:

```text
Cleanup tray  →  Review  →  Recycle Bin
Move tray     →  Review  →  the folder you chose
```

You collect things from any view — including an **Organise** suggestion — into the tray. When
you're ready, Bird's Eye **checks every item again** against what's actually on your drive right
now — sizes, labels and paths — and shows you precisely what will happen. Only after you
confirm does anything move. No view has a shortcut around this.

## Everything is reversible

- **Recycle Bin first, always.** Deleted items go to the Windows Recycle Bin with a record of
  what happened, not to oblivion.
- **Restorable for 30 days** from **Recently cleaned**, or undone instantly with **Undo** right
  after the action.
- **Move instead of delete.** Sometimes the right answer isn't deleting — it's putting a file
  somewhere sensible. The **Organise** view finds these for you, or move files by hand; either
  way Bird's Eye brings its records up to date with a background rescan afterwards. A move can
  be undone right after it happens — it never touches the Recycle Bin, so it doesn't have the
  30-day window a deletion has.

## The three labels

Everything Bird's Eye recommends carries a label, and every label comes with its **size**, **how
long since you touched it**, and **a reason** — never a bare instruction.

| Label | What it means |
|---|---|
| **Safe to delete** | You can rebuild it, it's temporary, or it's a duplicate — build output, caches, installer leftovers. |
| **Check first** | Probably fine, but worth your eyes on it first. Here's what it is; you decide. |
| **Don't touch** | In use, part of Windows, something depends on it, or you pinned it. Shown with the reason, never hidden. |

There are three, and there will never be a fourth. Three is as many as anyone can read at a
glance down a list of hundreds of rows.

## Things it holds back are shown, not hidden

When Bird's Eye decides something shouldn't be removed, it does **not** quietly drop it from the
list. It stays visible with the reason it was held back, and you keep the final say: an
explicit, clearly-marked **override** lets you remove it anyway. The app's job is to give you
the evidence, not to overrule you.

## The analysis is honest about what it knows

The labels and the reasons come from the analysis that runs alongside every scan. It's worth
being precise about what that is and isn't:

- **It's a set of rules, running on your PC.** No machine learning, no cloud, no external
  services. No model ever sees your files.
- **It shows its working.** Every recommendation comes with the reason it was made.
- **It never makes anything up.** If it can't tell what a folder is, it says so rather than
  inventing a purpose or a confidence it doesn't have.

If you'd rather just see sizes, you can turn the analysis off in **Settings**.

## No scare tactics, on purpose

Bird's Eye will never nag you, never delete anything on its own, and never invent urgency to
push you at a "clean now" button. There is no health score, no "247 issues found," no red badge,
no countdown. It tells you what's there, what it thinks, and why — and then it waits for you.
