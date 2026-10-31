---
description: Give a rundown of a failed work item of a campaign, with suggestions and proposed work items
argument-hint: "<goal, shipped items, failed item, its result and remaining items>"
---
Give a rundown of the failed work item.

The `goal` is what the campaign set out to do. The `shipped` items are already commits in the worktree, as JSON with each item, its commit and its divergence: how the commit differs from the item, or `none`. The `item` is the work item that failed, and `status` tells how it failed. The `reply` is the last report of the implementer, the `handoff` is the plan that the last round used, the `findings` are the judge's findings, and the `memory` is the run memory of the campaign. The `remaining` items are the items that were still to run, in order, as JSON. The `patch` is the path of the full diff of the failed item from the reset commit: `git apply <path>` applies it to the reset worktree.

The worktree is reset to the last shipped commit, or to the start commit when no item shipped: the worktree has no change from the failed item, but the patch keeps its work.

Read the shipped commits and the code that the item touches. Give a short rundown of what failed and why. Give suggestions to continue. Give the proposed work items that complete the goal from the reset commit, each one as the full text of one work item.

When the review passed and only the judge failed, or when most of the item works, start the proposed items with an item that runs `git apply <path>` with the patch, fixes only what failed, and tells how to check the fix. In other cases, you can ignore the patch.

Answer with respond: rundown, suggestions and items.

$@
