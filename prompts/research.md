---
description: Document the code that a change touches, as it is today
argument-hint: "<work item>"
---
Research the codebase for this change. Your only job is to document the code as it is today, for a planner who starts from your document with a fresh context.

## Rules

- Describe what exists, where it is, and how it works. Do not suggest changes, improvements or a solution, do not critique the code, and do not plan.
- Read repository instructions first. Then split the work item into research questions: which files and components it touches, how the current behavior works end to end, and which existing patterns, conventions and tests a change here must follow.
- Search in parallel where questions are independent. If you have a subagent tool, spawn subagents to locate files, to trace a flow, and to find similar code, then read the files they name yourself before you rely on them.
- Back every claim with a `path:line` reference. Separate what you read from what you infer, and say what you could not find.

## Write the research document

**Summary:** what the relevant code does today, in a few sentences.

**Findings:** one short section per component or flow, with `path:line` references.

**Patterns and tests:** the conventions, similar implementations and tests that relate to this area.

**Open questions:** what the code does not answer.

Keep it dense: the planner reads it instead of the codebase, so leave out what does not bear on the work item.

$@
