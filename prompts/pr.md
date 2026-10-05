---
description: Write a pull request title and body for an accepted campaign
argument-hint: "<goal, base ref, campaign tip, stop details>"
---
Write a pull request title and body for the accepted campaign changes in this checkout.

Load and follow the `writing-pr` skill. Read the repository instructions, then inspect the aggregate diff from the exact `base` ref to the accepted campaign tip `head`. Describe the final changes, not the individual work item attempts. The goal gives context, but do not claim work that is absent from the diff.

If `stop` reports an early stop, explain the stopped work item and reason in the body. Distinguish accepted work from work that remains unfinished. Otherwise, do not invent unfinished work.

Only inspect the repository and write the text. Do not change files, push, or create a pull request.

$@
