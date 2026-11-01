---
description: Distil the lessons of one run from its notes
argument-hint: "[the work item, the outcome, the run and the notes]"
---
Distil the lessons of this run.

Read the work item, the outcome of the run and the notes of its run memory below.

- Give 0 to 3 lessons. Give `[]` when no lesson qualifies; this is the default.
- A lesson is a reusable contrast that transfers beyond this commit: do this instead of that. It is never a changelog of
  the commit: `git log` already records what changed.
- A note row that says `confounded yes` comes from a change to more than one file that no rollout isolates, so it cannot
  tell which change made its verdict. Give no lesson that rests only on such rows.
- `cue`: when the lesson applies.
- `lesson`: what to do, instead of what.
- `evidence`: `run:<run>`, or the `#conv` ID when the notes give one, with the numbers of the notes that the lesson rests
  on, for example `run:20260101T000000-abcd1234 #3 #7`.

Answer with respond: lessons.

$@
