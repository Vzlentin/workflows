- Check: `npm run check` (Biome, TypeScript, Vitest). The judge session runs the checks listed here.
- README.md is the behaviour spec: output lines, exit codes, run directory layout, commit message format. Update it in the same change as the behaviour.
- `dist/` is ignored build output, and `bin` points to it. Run `npm run build` before you try the `workflows` command.
- Dependency versions are pinned exactly. The four `@earendil-works/*` packages share one version; change them together. Until 1.2.0 is on npm, pi-durable is ahead of the others, at the build in the GitHub release asset.
- Pi supplies `pi-ai` and `pi-coding-agent` to the extension, so they are `peerDependencies` at `"*"`. The CLI child process runs outside Pi and needs its own copies, so they are also `optionalDependencies` at `^1.1.0`: Pi's git install (`npm install --omit=dev --legacy-peer-deps`) keeps optional dependencies, and Pi warns only about its own packages in `dependencies`. Do not put them in `dependencies` or `devDependencies`. Pi also supplies `pi-tui`, which only the extension uses, so it is only a `peerDependencies` entry at `"*"`. `chord`, `pi-codemode` and `pi-durable` stay in `dependencies`.
- The extension starts the CLI from source, `src/cli.ts`, because a git install has no `dist/`. Keep `src/` runnable with Node type stripping. The `bin` stays `dist/cli.js`.
- Never verify with a real `workflows` run. It spends model calls, and inside a ship run it starts another run.

## Library and workflows

- `src/lib/` is the library: run directory, durable store, sessions, turns, retry, resume, Git repository selection, prompts, and `meta.ts`, the generic entry point that runs any workflow script as `workflows <wf>`. `run(name, args)` in a script starts a child run with its own run directory and store, through `ExtensionHost.child`, which `main.ts` provides.
- `src/lib/` never imports a workflow. Biome enforces it.
- A workflow script declares its description, arguments, worktree and exit codes in `export const meta = { ... }`, a literal object at the top. It returns its report lines as `result.report`.
- `optimize` is the workflow script `workflows/optimize.js`: it evaluates each candidate with `run("ship", ...)` child runs, and reads and writes files through `sh`.
- `ship` is the workflow script `workflows/ship.js`: its `meta` gives the work item, the rounds and the worktree, and the script does the plan, the rounds, the review, the judge, the squash and the report lines.
- Every script run is the task `workflows.run`. Bump its `version` in `src/lib/meta.ts` when the shape of its saved input changes.
- Biome does not check `workflows/*.js`: a script body has a top-level `return`.

## Durable runs

- Saved runs in `durable.sqlite` resume against the current code. When you change the shape of a workflow's input or checkpoints, or of `Stored` in `src/lib/workflow.ts`, bump the workflow's `version`. A run saved by an earlier version cannot resume.
- A phase can rerun after an interruption or a failure. Keep Git steps safe to repeat, and keep each `say` request ID unique in its session: an answered request ID returns its saved answer, and a failed one is sent again under the next free ID.
- A workflow script also runs again from the top at resume. Keep its `sh` and `ok` Git steps safe to repeat: a step whose result was not saved runs again.
- A run saves its prompts and models before it starts. Prompt or model edits change only new runs.

## Prompts

- Keep the frontmatter and the last line `$@` in `prompts/*.md`. `instructions()` removes them.
- The SHIP or FIX answer rule and the evidence rule of the review challenge are in `workflows/ship.js`. Do not move them into a template.
- The judge answers the eight numbered questions of `prompts/judge.md` through `respond`, in question order, and `score()` in `workflows/ship.js` reads them. Keep the numbering and the meaning of questions 1 and 2.

## Tests

- Tests must not call a real model, a real `gh`, or the user's Pi or Git configuration. Use `sandbox()` and the faux provider in `test/support.ts`.
