---
description: Write a better version of one ship prompt from the results of ship runs
argument-hint: "<prompt name, current text and records>"
---
Improve this prompt of `workflows ship`.

The `prompt` is the name of the prompt template, and `current` is its text. The `records` are ship runs that used this text, as JSON: for each run, the work item, its score from 0 to 1, the findings of the judge, and the notes of the run memory. A higher score means that the judge passed more questions in fewer rounds.

Find the patterns in the low scores and in the findings. Change the prompt so that the next runs avoid them. Keep what the high scores show works. Keep the role of the prompt in the ship workflow, and keep the inputs that it names.

Reply with the full new text of the prompt only: no frontmatter, no comments, no code fence.

$@
