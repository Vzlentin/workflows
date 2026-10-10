- Check: `npm run check` (Biome, TypeScript, Vitest). The judge session runs the checks listed here.
- README.md is the behaviour spec: output lines, exit codes, run directory layout, commit message format. Update it in the same change as the behaviour.
- `dist/` is ignored build output, and `bin` points to it. Run `npm run build` before you try the `workflows` command.
- Dependency versions are pinned exactly. The four `@earendil-works/*` packages share one version; change them together. Until 1.2.0 is on npm, pi-durable is ahead of the others, at the build in the GitHub release asset.
- Never verify with a real `workflows` run. It spends model calls, and inside a ship run it starts another run.

## Library and workflows

- `src/lib/` is the library: run directory, durable store, sessions, turns, retry, resume, Git repository selection and prompts. `src/workflows/` holds one file per workflow, built only on the library. `src/cli.ts` lists the installed workflows.
- `src/lib/` never imports from `src/workflows/`. Biome enforces it.
- A workflow declares its arguments, saved input, phases and report. Keep logic that only one workflow needs in its file.
- `ship` keeps its arguments, repository selection, worktree and report in `src/workflows/ship.ts`. The plan, the rounds, the review, the judge and the squash are in the workflow script `workflows/ship.js`, which runs on the runtime of `workflows run`.
- Biome does not check `workflows/*.js`: a script body has a top-level `return`.

## Durable runs

- Saved runs in `durable.sqlite` resume against the current code. When you change the shape of a workflow's input or checkpoints, or of `Stored` in `src/lib/workflow.ts`, bump the workflow's `version`. A run saved by an earlier version cannot resume.
- A phase can rerun after an interruption or a failure. Keep Git steps safe to repeat, and keep each `say` request ID unique in its session: an answered request ID returns its saved answer, and a failed one is sent again under the next free ID.
- A workflow script also runs again from the top at resume. Keep its `sh` and `ok` Git steps safe to repeat: a step whose result was not saved runs again.
- A run saves its prompts and models before it starts. Prompt or model edits change only new runs.

## Prompts

- Keep the frontmatter and the last line `$@` in `prompts/*.md`. `instructions()` removes them.
- The SHIP or FIX answer rule of the review challenge is in `workflows/ship.js`. Do not move it into a template.
- The judge answers the eight numbered questions of `prompts/judge.md` through `respond`, in question order, and `score()` in `workflows/ship.js` reads them. Keep the numbering and the meaning of questions 1 and 2.

## Tests

- Tests must not call a real model, a real `gh`, or the user's Pi or Git configuration. Use `sandbox()` and the faux provider in `test/support.ts`.
