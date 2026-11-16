- Toolchain: Vite+ (the `vp` command). The config of every tool is in the root `vite.config.ts`.
- Check: `npm run check` (format, lint and type check, build, `tsc -p tsconfig.json`, `tsc -p workflows/jsconfig.json`, `vp test`). The judge session runs the checks listed here.
- `vp check --fix` formats files and autofixes lint spacing rules (including anti-slop/require-readable-spacing).
- `docs/spec.md` is the behaviour spec. Update it in the same change as the behaviour. `README.md` has only the install, a short usage and development.
- Two npm packages, with one version: `@vzlentin/workflows` (root) and `@vzlentin/pi-workflows` (`pi/`). Pi supplies `pi-ai`, `pi-coding-agent`, `pi-tui` and `typebox`: they are `peerDependencies` at `"*"` in `pi/package.json`.
- `pi/index.ts` loads `dist/` files by path. At runtime it imports only `dist/tool.js` of the package, plus type-only imports of `src/tool.ts`.
- The checkout runs from source with Node type stripping (`node src/cli.ts`). Keep `src/` runnable that way.
- Dependency versions are pinned exactly, except `@vzlentin/harness`: a Git SHA during development, and a registry range for a release (`.github/scripts/harness-range.sh` fails the publish job otherwise). The `@earendil-works/*` packages share one version, equal to harness's.
- Never verify with a real `workflows` run. It spends model calls, and inside a ship run it starts another run.

## Engine and workflows

- Each file in `src/` starts with a `/**` header that says what the module owns: `rg -m1 '^/\*\*' src`. Keep the header true when you change what a module owns. `docs/spec.md` has the behaviour.
- A group of `src/` imports at runtime only the groups before it in the chain `workflow ← launch ← run ← records ← cli`, with no module import cycle; a type-only import does not count.
- `git.ts`, `tool.ts` and `command.ts` are top-level leaves that every group can import. `tool.ts` imports at runtime only `typebox` and `node:*`, because Pi loads `dist/tool.js` alone. Lint enforces these rules.
- The workflows are data: `workflows/` holds `scripts/*.js`, `lib/*.js`, `prompts/*.md` and `agents.json`. There is no workflow in TypeScript.
- A workflow script declares `export const meta = { ... }`, a literal object at the top.
- `workflows/script.d.ts` is the only source of the script types: declare each lib helper there. A lib file only declares and runs no code when it loads.

## Durable runs

- Bump `TASK.version` in `src/run/version.ts` when the shape of the saved input or the checkpoint changes. Only a task at exactly `TASK.version` resumes.
- A resume runs the script and its phases again from the top. Keep `sh` and `ok` Git steps safe to repeat.
- Keep each turn request ID unique in its session: an answered request ID returns its saved answer.

## Prompts

- Keep the frontmatter and the last line `$@` in `prompts/*.md`. `instructions()` removes them.
- The rules of the review loop are in `workflows/scripts/thermoloop.js`. Do not move them into a template.
- The judge answers the eight numbered questions of `prompts/judge.md` through `respond`, in question order, and `score()` in `workflows/scripts/judge.js` reads them. Keep the numbering and the meaning of questions 1 and 2.

## Tests

- Use `sandbox()` and the faux provider of `test/support.ts`.
- Tests must not call a real model, a real `gh`, `hc` or `npm`, the user's Pi or Git configuration, or the user's `memo`.
- Never run the tests under `git rebase -x` or in a Git hook: Git exports `GIT_DIR` and others to them.
