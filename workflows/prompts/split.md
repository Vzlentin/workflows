---
description: Split a goal into parts
argument-hint: "<goal>"
---
Split this goal into parts.

Read repository instructions and the code that the goal touches before you split it. Investigation cannot expand the goal.

Each part ships as one commit, after the parts before it, through a full ship: plan, implement, review rounds and judge. Order the parts so that each one builds only on the parts before it, and make each one complete on its own: the repository checks pass after it.

Choose the size of the parts with the batch-size trade-off of Reinertsen (The Principles of Product Development Flow). Each part pays a fixed cost, about 30 minutes, whatever its size. A larger part delays the review of its first line, and a late finding costs more when other work builds on it.

```
 cost
  │╲                         ╱  delay: late findings compound
  │ ╲                      ╱
  │  ╲    total          ╱
  │   ╲___         ____╱
  │       ‾‾‾‾‾‾‾‾‾
  │  fixed cost per part
  └──────────────────────────── part size
```

- Merge small changes that serve one purpose into one part: a version pin, a fixture or a rename does not pay for a ship alone.
- Split where an error would spread: a change that later parts build on, such as a protocol, a schema or a shared module, is its own part, first.
- Keep each part small enough for one implement and review session.

The number of parts is your choice. When the goal gives a number or a list of parts, take it as the scope, not as the cut.

Write each part for an agent that has not seen this session: a first line that names the change, then the contract, the protected behavior and the proof. Do not add parts that the goal does not need.

Give a `subject` for the whole goal: one line, a Conventional Commit subject, for example `feat: show background runs in Pi`. It names the branch of the campaign.

When `shipped`, `rundown` and `answer` are given, the shipped parts are already commits in the worktree, and a part failed after them. Give only the parts that complete the goal from there, and follow the answer.

$@
