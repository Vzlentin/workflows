---
description: Propose edits to the skills and AGENTS.md that ship sessions load, from the traces of ship runs
argument-hint: "<texts, traces and roots>"
---
Propose edits to the practitioner skills and the `AGENTS.md` that the sessions of `workflows ship` load.

The `texts` are the current texts by path, as JSON: `AGENTS.md` is the always-on instructions of the repository, `.agents/skills/<name>/SKILL.md` and `.pi/skills/<name>/SKILL.md` are the skills of the repository, and an absolute path is a skill of the user. The `traces` are ship runs that used these texts, as JSON: for each run, its run ID, the work item, the status, the review rounds, the findings of the judge, the divergence of the commit from the work item, the lessons of the run, and the notes of the run memory. The `roots` are the folders of the user skills, as JSON.

Find the moments in the traces where a run went wrong or lost time because it lacked know-how of the domain: a finding, a note, a divergence or a lesson. Write that know-how into a skill, a new one or one of `texts`, or into `AGENTS.md` when every session needs it. Keep `AGENTS.md` short: it is in every session. A skill starts with a frontmatter that has its `name` and its `description`.

Answer with respond. Each edit has `path`, `AGENTS.md`, `.agents/skills/<name>/SKILL.md`, `.pi/skills/<name>/SKILL.md` or `<root>/<name>/SKILL.md` for a root of `roots`; `text`, the full new text of that path, or null to remove it; and `moment`, the run ID and the finding or note that the edit answers. Give each path at most once, and no edit when the traces show no lack of domain know-how.

$@
