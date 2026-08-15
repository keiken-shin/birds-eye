---
title: Stage, group, and review
description: Set files and folders aside, group them into a decision, and review exactly what Bird's Eye will clean or move.
---

# Stage, group, and review

**Staged** is the space between spotting something and changing your drive. Use it when you know
an item deserves attention but you are not ready to delete or move it yet.

Anything you stage stays there when you close Bird's Eye. You can collect items from different
views, group related decisions, and review a small selection without clearing everything else.

<figure markdown="span">
  ![The Staged workspace with files grouped for a later decision](../assets/screenshots/staged.png){ .be-shot }
  <figcaption>Staged keeps the items you set aside, their sizes, reasons, and groups in one place.</figcaption>
</figure>

## Stage an item

Staging is offered wherever Bird's Eye lists a file or folder:

- In **Clean up**, tick one or more recommendation rows, then choose **Stage selected**.
- In **Files**, **Duplicates**, or **By age**, use the **Stage** button on the row.
- In the **Inspector**, choose **Add to cleanup tray**. The button then reads **Staged — remove**,
  which takes it back off.

The **Map** has no stage button of its own: click a tile to select the folder, then stage it from
the Inspector.

The tray along the bottom follows you between views. It shows what is waiting, the total size, and
whether an item is queued for cleaning or moving.

!!! tip "Stage is not delete"
    Staging changes no files. It records the decision in the scan index and keeps it across app
    restarts. The file changes only after you open Review and confirm the plan.

## Use the Staged workspace

Open **Staged** from the top switcher or press **3**.

Loose items appear under **Not in a group**. Select related items and give the group a name such
as `Archive`, `Old project`, or `Move to Photos`. Groups are labels for your own decision;
they do not create folders or change paths.

A group can contain files and folders. Bird's Eye keeps the original path, size, safety label,
and reason beside each item, so you do not have to remember why you staged it.

To take an item off the desk without touching the file, choose **Remove** on its row. **Clear all**
clears every staged decision, again without touching a single file.

## Review a clean

1. Tick the items you want to remove, or leave nothing ticked to review the whole desk.
2. Choose **Review & delete** — the button counts your selection, or reads **Review & delete all**
   when you have ticked nothing. (From the bottom tray the same gate is labelled **Review & clean**,
   and always covers everything staged.)
3. Read the plan. Check the exact paths, the space total, and anything Bird's Eye held back.
4. Confirm only when the list matches the decision you intended.

Reviewing a selection leaves the rest of the desk exactly as it was — its items, and its groups.

The cleanup plan records the files you reviewed and checks them against the live index again
before acting. A newly qualifying file cannot silently join the batch; a file that no longer
qualifies drops out.

After confirmation, Bird's Eye sends the items to the Windows Recycle Bin. The immediate
**Undo** action and **Recently cleaned** both use the recorded cleanup history.

## Review a move

A move follows the same shape, with the destination chosen first:

1. In a group, choose **Move…** — the button counts the files it can move.
2. Pick the destination folder, and optionally name a new subfolder to create inside it.
3. Read each source and destination pair.
4. Confirm the plan.

The bottom tray offers the same gate as **Review & move** for anything staged with a destination
already attached, such as an **Organise** suggestion.

Bird's Eye checks the source and destination again before it moves anything. Completed moves
appear in **Recently cleaned** with **Put back**. If an interrupted move has uncertain state, the
history says **Interrupted** instead of claiming the move completed.

Folders can be staged for cleanup. Direct relocation is file-based, so a group that mixes files
and folders may need separate clean and move decisions.

## Confirm findings before they become recommendations

Some recommendations depend on a relationship Bird's Eye inferred, such as a build output linked
to its source or a backup that has another copy. Those questions now appear at the top of
**Clean up**, not in Staged.

Choose **Yes** when the relationship is correct or **No** when it is not. Confirming a finding can
add the corresponding item to the recommendation list below, making the cause and result visible
on the same screen.

## Recover or change your mind

- **Before review:** unstage the item. Nothing on disk changed.
- **Immediately after a clean or move:** use **Undo** in the toast.
- **Later:** open **Recently cleaned** and use **Restore** or **Put back**.
- **After a clean:** Windows also keeps the item in the Recycle Bin.

See [Working safely](working-safely.md) for the full recovery model and its limits.

