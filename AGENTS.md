- Check: `npm run check` (Biome, TypeScript, Vitest). The judge session runs the checks listed here.
- README.md is the behaviour spec: output lines, exit codes, run directory layout, commit message format. Update it in the same change as the behaviour.
- `dist/` is ignored build output, and `bin` points to it. Run `npm run build` before you try the `workflows` command.
- Dependency versions are pinned exactly. The four `@earendil-works/*` packages share one version; change them together.
- Pi supplies `pi-ai` and `pi-coding-agent` to the extension, so they are `peerDependencies` at `"*"`. The CLI child process runs outside Pi and needs its own copies, so they are also `optionalDependencies` at `^1.3.0`: Pi's git install (`npm install --omit=dev --legacy-peer-deps`) keeps optional dependencies, and Pi warns only about its own packages in `dependencies`. Do not put them in `dependencies` or `devDependencies`. Pi also supplies `pi-tui`, which only the extension uses, so it is only a `peerDependencies` entry at `"*"`. `chord`, `pi-codemode` and `pi-durable` stay in `dependencies`.
- `harness` is a dependency at a Git ref. `extensions/subagent.ts` loads its Pi extension, unless Pi also has a separate harness package (`src/harness.ts`). Bump the ref to take a harness change. The `harness` command runs `node_modules/harness/bin/harness.mjs`, which loads harness's source through jiti. The CLI runs with plain Node, so `src/main.ts` loads harness's modules through jiti (`createJiti(...).import("harness/src/client.ts")`); type-only imports from `harness/src/*.ts` are fine. Vitest inlines harness (`vitest.config.ts`).
- `postinstall` runs `scripts/link-bins.ts`, which links `workflows` and `harness` into `~/.local/bin` for a Pi git install and does nothing in a checkout. `pi update` runs it on each update, so keep it safe to run again, and keep it from changing any link before all links pass its checks.
- The extension starts the CLI from source, `src/cli.ts`, because a git install has no `dist/`. Keep `src/` runnable with Node type stripping. The `bin` stays `dist/cli.js`.
- Never verify with a real `workflows` run. It spends model calls, and inside a ship run it starts another run.

## Engine and workflows

- `src/` is the engine: run directories, the script task, sessions, turns, retry, resume, Git repository selection, prompts, and `meta.ts`, the generic entry point that runs any workflow script as `workflows <wf>`. A run executes in the harness host of its project: `src/entry.ts` is the `piDurable` entry (declared in `package.json`) that the host loads, and it gives the host the script task. The CLI in `main.ts` is a client: it prepares the input, writes `runs/<id>/project`, sends `start` with the key `wf:<run ID>#<n>`, and follows the run with `wait-task` while it polls the progress documents in the project store read-only. `task.ts` holds the script task and its checkpoint; its saved input is `ScriptInput` of `meta.ts`. `script.ts` holds the script calls and sessions, which are children of harness's children library, opened with a task owner whose group is the run ID, keyed `wf:<run ID>/<call key>`. `run.ts` holds the run ID, `UsageError`, `Run` and `Io`. `run(name, args)` in a script starts a child run with its own run directory, as a pi-durable child task of the caller's task. The caller waits for the child task with `waitForTask`. A failed phase commits a `failed` outcome, so the waiter of a child or root task sees the failure in the task's outcome.
- The workflows are data: `workflows/*.js`, `prompts/*.md` and `agents/*.md`. There is no workflow in TypeScript.
- A workflow script declares its description, arguments, worktree and exit codes in `export const meta = { ... }`, a literal object at the top. It returns its report lines as `result.report`.
- `optimize` is the workflow script `workflows/optimize.js`: it evaluates each candidate with `run("ship", ...)` child runs, and reads and writes files through `sh`.
- `ship` is the workflow script `workflows/ship.js`: its `meta` gives the work item, the rounds and the worktree, and the script does the plan, the rounds, the review, the judge, the squash and the report lines.
- Every script run is the task `workflows.run`, `scriptTask(host)` in `src/task.ts`, whose name and version are `TASK`. Bump `TASK.version` when the shape of its saved input changes.
- A run has one live task at a time. Start and resume share one way to follow a task. `resume` follows the run's last task when it has not ended, and starts a new task with the same input when it ended without completing. Keep a new kind of run on that path. A child run is not a run of its own: `list` and `resume` see only root tasks. A failed task, root or child, ends as `failed`. The saved calls of a script are session-scoped documents of the store, keyed `<run ID>/<call key>`, so they stay after the task ends; a `run()` call creates a new child task with the input of a child task that ended without completing. Each call document records the call's kind, args, phase, start and end times, and its result or error; only a saved `result` replays. `show`, `list` and `save` in `main.ts` read these records and the root tasks from the project store file, with no Harness and no host. They take short write locks while the host writes, so every store open in `main.ts` uses the 60-second busy timeout `STORAGE`.
- The end of a run ends its sessions (`endSessions` in `task.ts`): a completed run closes them; a failed or aborted run closes only what is under them and aborts the turns of the sessions that an earlier task of the run opened, which pi-durable's abort of the current task does not reach.
- Ctrl+C detaches the CLI and the run goes on in the host. A second Ctrl+C within `stopWindowMs`, or `workflows stop`, sends `abort-task`.
- Biome does not check `workflows/*.js`: a script body has a top-level `return`.

## Durable runs

- Saved runs in the project store resume against the code that the host loaded. When you change the shape of the stored input or the checkpoint, bump `TASK.version` in `src/task.ts`. Only a task at exactly `TASK.version` resumes: a run saved by an earlier or a later version cannot resume, and the host leaves it pending.
- The harness host lock covers the store; workflows has no lock of its own.
- A phase can rerun after an interruption or a failure. Keep Git steps safe to repeat, and keep each turn request ID unique in its session: an answered request ID returns its saved answer, and a failed one is sent again under the next free ID. An answer that stopped for a reason other than its end or a tool call, such as its length, counts as failed.
- A workflow script also runs again from the top at resume. Keep its `sh` and `ok` Git steps safe to repeat: a step whose result was not saved runs again.
- A run saves its prompts and models before it starts. Prompt or model edits change only new runs.

## Prompts

- Keep the frontmatter and the last line `$@` in `prompts/*.md`. `instructions()` removes them.
- The SHIP or FIX answer rule and the evidence rule of the review challenge are in `workflows/ship.js`. Do not move them into a template.
- The judge answers the eight numbered questions of `prompts/judge.md` through `respond`, in question order, and `score()` in `workflows/ship.js` reads them. Keep the numbering and the meaning of questions 1 and 2.

## Tests

- Tests must not call a real model, a real `gh`, or the user's Pi or Git configuration. Use `sandbox()` and the faux provider in `test/support.ts`. Each `workflows(...)` call of a test runs an in-process harness host with its own fake model, which loads this checkout as a local Pi package, and closes it when the command ends, as a host stop does.
