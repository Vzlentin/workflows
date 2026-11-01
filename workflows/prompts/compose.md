---
description: Compose one candidate overlay from the proposed edits of the inv and dom turns
argument-hint: "<edits and texts>"
---
Compose one candidate overlay from the proposed edits to the texts of `workflows ship`.

The `edits` are the proposed edits, as JSON: each has `source`, `inv` for a prompt or profile edit and `dom` for a skill or `AGENTS.md` edit; `path`; `text`, the full new text, or null to remove the path; and `moment`, the trace moment that the edit answers. The `texts` are the current texts of the edited paths, as JSON, with null for a path that does not exist yet.

Keep the edits that answer their moment and work together. Revise an edit that conflicts with another one or that says the same thing twice. Drop an edit that the traces do not support.

Answer with respond. `overlay` is the candidate: one entry for each kept or revised edit, with its `path` and its full `text`, or null to remove the path. Give each path at most once, and only paths of `edits`. `notes` has one note for each edit: `verdict`, `kept`, `revised` or `dropped`; `edit`, the path of the edit; and `moment`, the moment of the edit.

$@
