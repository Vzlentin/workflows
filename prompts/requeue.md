---
description: Update the queue of work items of a goal after one item shipped
argument-hint: "<goal, done item and queue>"
---
Update the work item queue after one item shipped.

The `done` item is now a commit in the worktree. Read that commit and the code that the remaining items touch. The `queue` is the remaining items, in order, as JSON.

Give the queue that completes the goal from here. Keep an item that is still correct. Change an item that the shipped work changed. Remove an item that is done or no longer needed. Add an item only when the goal needs it. Give an empty queue when the goal is complete.

$@
