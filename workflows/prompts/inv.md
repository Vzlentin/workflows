---
description: Propose edits to the ship prompts and agent profiles from the traces of ship runs
argument-hint: "<texts and traces>"
---
Propose edits to the workflow prompts and agent profiles of `workflows ship`.

The `texts` are the current texts by path, as JSON: `prompts/<name>.md` is a prompt template without its frontmatter, and `agents/<name>.md` is an agent profile. The `traces` are ship runs that used these texts, as JSON: for each run, its run ID, the work item, the status, the review rounds, the findings of the judge, the divergence of the commit from the work item, the lessons of the run, and the notes of the run memory.

Find the moments in the traces where a run went wrong or lost time: a finding, a note, a divergence or a lesson. Change the texts so that the next runs avoid them. Keep what the traces show works. Keep the role of each text in the ship workflow, the inputs that a prompt names, and the first sentence of each prompt.

Answer with respond. Each edit has `path`, a key of `texts`; `text`, the full new text of that path, or null to remove it; and `moment`, the run ID and the finding or note that the edit answers. Give at least one edit, and each path at most once.

$@
