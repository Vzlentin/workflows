- Check: `npm run check` (Biome, TypeScript, Vitest). The judge session runs the checks listed here.
- README.md is the behaviour spec: output lines, exit codes, run directory layout, commit message format. Update it in the same change as the behaviour.
- `dist/` is ignored build output, and `bin` points to it. Run `npm run build` before you try the `workflows` command.
- Dependency versions are pinned exactly. The four `@earendil-works/*` packages share one version; change them together. Until 1.2.0 is on npm, pi-durable is ahead of the others, at the build in the GitHub release asset.
- Pi supplies `pi-ai` and `pi-coding-agent` to the extension, so they are `peerDependencies` at `"*"`. The CLI child process runs outside Pi and needs its own copies, so they are also `optionalDependencies` at `^1.1.0`: Pi's git install (`npm install --omit=dev --legacy-peer-deps`) keeps optional dependencies, and Pi warns only about its own packages in `dependencies`. Do not put them in `dependencies` or `devDependencies`. Pi also supplies `pi-tui`, which only the extension uses, so it is only a `peerDependencies` entry at `"*"`. `chord`, `pi-codemode` and `pi-durable` stay in `dependencies`.
- The extension starts the CLI from source, `src/cli.ts`, because a git install has no `dist/`. Keep `src/` runnable with Node type stripping. The `bin` stays `dist/cli.js`.
- Never verify with a real `workflows` run. It spends model calls, and inside a ship run it starts another run.

## Engine and workflows

- `src/` is the engine: run directory, durable store, sessions, turns, retry, resume, Git repository selection, prompts, and `meta.ts`, the generic entry point that runs any workflow script as `workflows <wf>`. `task.ts` holds the script task and its checkpoint; its saved input is `ScriptInput` of `meta.ts`. `script.ts` holds the script calls and sessions. `run.ts` holds the run ID, `UsageError`, `Run` and `Io`. `run(name, args)` in a script starts a child run with its own run directory, as a pi-durable child task of the caller's task in the caller's store. The caller waits for the child task with `waitForTask`. A failed phase commits a `failed` outcome, so the waiter of a child or root task sees the failure in the task's outcome.
- The workflows are data: `workflows/*.js`, `prompts/*.md` and `agents/*.md`. There is no workflow in TypeScript.
- A workflow script declares its description, arguments, worktree and exit codes in `export const meta = { ... }`, a literal object at the top. It returns its report lines as `result.report`.
- `optimize` is the workflow script `workflows/optimize.js`: it evaluates each candidate with `run("ship", ...)` child runs, and reads and writes files through `sh`.
- `ship` is the workflow script `workflows/ship.js`: its `meta` gives the work item, the rounds and the worktree, and the script does the plan, the rounds, the review, the judge, the squash and the report lines.
- Every script run is the task `workflows.run`, `scriptTask(host)` in `src/task.ts`, whose name and version are `TASK`. Bump `TASK.version` when the shape of its saved input changes.
- Start and resume share one way to open a run, which continues the run's root task or creates a new one, and one way to wait for the task to end. Keep a new kind of run on that path. A child run is not a run of its own: `list` and `resume` see only root tasks. A failed task, root or child, ends as `failed`. The saved calls of a script are session-scoped documents of the store, keyed `<run ID>/<call key>`, so they stay after the task ends: a resume creates a new root task with the input of an ended one that did not complete, and a `run()` call creates a new child task with the input of a child task that ended without completing. Each call document records the call's kind, args, phase, start and end times, and its result or error; only a saved `result` replays. `show` in `main.ts` reads these records and the root task from the storage, with no Harness. It takes short write locks, so every store open in `main.ts` uses the 60-second busy timeout `STORAGE`.
- Biome does not check `workflows/*.js`: a script body has a top-level `return`.

## Durable runs

- Saved runs in `durable.sqlite` resume against the current code. When you change the shape of the stored input or the checkpoint, bump `TASK.version` in `src/task.ts`. Only a task at exactly `TASK.version` resumes: a run saved by an earlier or a later version cannot resume.
- One process runs a run at a time. `openStore` in `src/main.ts` first takes the lock of `src/lock.ts`, an exclusive transaction on `lock.sqlite` in the run directory, and its `close` releases it last. The system releases it when the process ends. `list`, `show` and child runs take no lock.
- A phase can rerun after an interruption or a failure. Keep Git steps safe to repeat, and keep each turn request ID unique in its session: an answered request ID returns its saved answer, and a failed one is sent again under the next free ID. An answer that stopped for a reason other than its end or a tool call, such as its length, counts as failed.
- A workflow script also runs again from the top at resume. Keep its `sh` and `ok` Git steps safe to repeat: a step whose result was not saved runs again.
- A run saves its prompts and models before it starts. Prompt or model edits change only new runs.

## Prompts

- Keep the frontmatter and the last line `$@` in `prompts/*.md`. `instructions()` removes them.
- The SHIP or FIX answer rule and the evidence rule of the review challenge are in `workflows/ship.js`. Do not move them into a template.
- The judge answers the eight numbered questions of `prompts/judge.md` through `respond`, in question order, and `score()` in `workflows/ship.js` reads them. Keep the numbering and the meaning of questions 1 and 2.

## Tests

- Tests must not call a real model, a real `gh`, or the user's Pi or Git configuration. Use `sandbox()` and the faux provider in `test/support.ts`.
