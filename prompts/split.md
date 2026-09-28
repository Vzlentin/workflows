---
description: Split a goal into the work items still needed to reach it
argument-hint: "<goal>"
---
Split this goal into the work items still needed to reach it from this checkout.

Read the repository instructions and the code the goal touches first. Leave out work the checkout already has.

Order the work items so that each one builds only on the ones before it. Each work item is a vertical slice: self-contained, with one observable result, and small enough for one fresh session to plan, implement and review. Put prefactoring first: a refactor that makes a later work item simple is its own work item before it. For a wide refactor, expand and contract: add the new path, migrate the callers, then remove the old path, each as its own work item.

Each work item starts with `# <title>`, then states its deliverables and acceptance criteria, not implementation steps. It must make sense without the goal or the other work items.

$@
