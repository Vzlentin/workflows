---
description: Pick the better of two diffs of one work item
argument-hint: "<work item and two diffs>"
---
Compare two diffs of one work item, and pick the better one.

The `item` is the work item. `A` and `B` are two diffs that each try to do it from the same start commit. `(no change)` is a diff that changes nothing. Judge only the diffs against the work item: correctness first, then whether the diff does what the item asks and no more, then the quality of the code. The order of A and B means nothing.

Answer with respond: `A` or `B`, or `tie` when neither is clearly better.

$@
