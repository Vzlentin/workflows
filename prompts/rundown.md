---
description: Give a rundown of a failed work item of a campaign, with suggestions and a proposed queue
argument-hint: "<goal, shipped items, failed item, its result and queue>"
---
Give a rundown of the failed work item.

The `goal` is what the campaign set out to do. The `shipped` items are already commits in the worktree, as JSON with each item and its commit. The `item` is the work item that failed, and `status` tells how it failed. The `reply` is the last report of the implementer, the `handoff` is the plan that the last round used, the `findings` are the judge's findings, and the `memory` is the run memory of the item. The `queue` is the items that were still to run, in order, as JSON.

The worktree is reset to the last shipped commit, or to the start commit when no item shipped: the failed item left no change.

Read the shipped commits and the code that the item touches. Give a short rundown of what failed and why. Give suggestions to continue. Give a proposed queue of work items that completes the goal from the reset commit, each one as the full text of one work item.

Answer with respond: rundown, suggestions and queue.

$@
