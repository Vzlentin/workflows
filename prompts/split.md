---
description: Split a goal into work items
argument-hint: "<goal>"
---
Split this goal into work items.

Read repository instructions and the code that the goal touches before you split it. Investigation cannot expand the goal.

Each work item ships as one commit, after the items before it. Make each item small enough for one implement and review session, and complete on its own: the repository checks pass after it. Order the items so that each one builds only on the items before it.

Write each item as a work item for an agent that has not seen this session: a first line that names the change, then the contract, the protected behavior and the proof. Do not add items that the goal does not need.

Give a `subject` for the whole goal: one line, a Conventional Commit subject, for example `feat: show background runs in Pi`. It names the branch of the campaign.

When `shipped`, `rundown` and `answer` are given, the shipped items are already commits in the worktree, and an item failed after them. Give only the items that complete the goal from there, and follow the answer.

$@
