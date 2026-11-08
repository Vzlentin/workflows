---
description: Write the commit message of one change
argument-hint: "[what the change is about]"
---
Write the commit message of this change. Read `git log base..head` and `git diff base head`.

Follow the commit rules of the repository: AGENTS.md, and the style of `git log`.

- `subject`: one line, a Conventional Commit, for example `fix: correct the README typo`.
- `body`: what changed and why, in short lines. Do not copy the work item.

When the prompt has a `findings` section, it holds the judge's findings on this change. Write a message that fixes the findings about the commit message.

Answer with respond: subject and body.

$@
