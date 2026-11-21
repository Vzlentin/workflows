---
description: Give a rundown of a failed part of a campaign, with suggestions and proposed parts
argument-hint: "<goal, shipped parts, failed part, its result and remaining parts>"
---
Give a rundown of the failed part.

The `goal` is what the campaign set out to do. The `shipped` parts are already commits in the worktree, as JSON with each part as `item`, its commit and its divergence: how the commit differs from the part, or `none`. The `item` is the part that failed, and `status` tells how it failed. After a fix round on the judge's findings, the `reply` and the `findings` come from the fix round. The `reply` is the last report of the implementer, the `handoff` is the plan that the last round used, the `findings` are the judge's findings, and the `memory` is the run memory of the campaign. The `remaining` parts are the parts that were still to run, in order, as JSON. The `patch` is the path of the full diff of the failed part from the reset commit: `git apply <path>` applies it to the reset worktree.

The worktree is reset to the last shipped commit, or to the start commit when no part shipped: the worktree has no change from the failed part, but the patch keeps its work.

Read the shipped commits and the code that the part touches. Give a short rundown of what failed and why. Give suggestions to continue. Give the proposed parts that complete the goal from the reset commit, each one as the full text of one part.

When the review passed and only the judge failed, or when most of the part works, start the proposed parts with a part that runs `git apply <path>` with the patch, fixes only what failed, and tells how to check the fix. In other cases, you can ignore the patch.

Answer with respond: rundown, suggestions, and the proposed parts as `items`.

$@
