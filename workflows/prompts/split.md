---
description: Split a goal into work items
argument-hint: "<goal>"
---
Split this goal into work items.

Read repository instructions and the code that the goal touches before you split it. Investigation cannot expand the goal.

Each work item ships as one commit, after the items before it, through a full ship: plan, implement, review rounds and judge. Order the items so that each one builds only on the items before it, and make each one complete on its own: the repository checks pass after it.

Choose the size of the items with the batch-size trade-off of Reinertsen (The Principles of Product Development Flow). Each item pays a fixed cost, about 30 minutes, whatever its size. A larger item delays the review of its first line, and a late finding costs more when other work builds on it.

```
 cost
  │╲                         ╱  delay: late findings compound
  │ ╲                      ╱
  │  ╲    total          ╱
  │   ╲___         ____╱
  │       ‾‾‾‾‾‾‾‾‾
  │  fixed cost per item
  └──────────────────────────── item size
```

- Merge small changes that serve one purpose into one item: a version pin, a fixture or a rename does not pay for a ship alone.
- Split where an error would spread: a change that later items build on, such as a protocol, a schema or a shared module, is its own item, first.
- Keep each item small enough for one implement and review session.

The number of items is your choice. When the goal gives a number or a list of items, take it as the scope, not as the cut.

Write each item as a work item for an agent that has not seen this session: a first line that names the change, then the contract, the protected behavior and the proof. Do not add items that the goal does not need.

Give a `subject` for the whole goal: one line, a Conventional Commit subject, for example `feat: show background runs in Pi`. It names the branch of the campaign.

When `shipped`, `rundown` and `answer` are given, the shipped items are already commits in the worktree, and an item failed after them. Give only the items that complete the goal from there, and follow the answer.

$@
