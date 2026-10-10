# workflows

`workflows ship` ships one work item onto a new branch through [Pi](https://github.com/earendil-works/pi) sessions.
The run is headless and resumable. [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) runs the
sessions, model calls and tool calls, and stores the progress of the run.

`src/lib/` is the library that runs workflows: run directories, the durable store, sessions, retries and resume.
`src/workflows/` holds the workflows built on it. `ship` is the only workflow.

```text
plan session:       plan  ->  challenge  ->  handoff
implement session:  implement the handoff                      <- round n (at most --rounds)
review session:     review  ->  challenge (SHIP or FIX)  ->  handoff (on FIX, back to implement)
judge session:      fixed rubric, after SHIP
```

Each box is a new session.

## Setup

Requires Node.js 22.19 or later, Git, and Pi with the pi-cursor package, logged in to the `cursor` provider (log in
once with `/login cursor` in `pi`).
GitHub repositories also need an authenticated `gh`.

```sh
npm ci
npm run build
node dist/cli.js ship plan.md
```

`npm link` installs the `workflows` command from this checkout.

## Ship

```sh
workflows ship plan.md
workflows ship "Fix the README typo"
echo "Fix the README typo" | workflows ship
workflows ship --repo calibre plan.md
workflows ship --repo owner/calibre --base develop plan.md
```

The work item comes from one argument or from stdin:

- An argument that ends in `.md` is a work item file, relative to the current directory. A missing file is an error.
- Any other argument is the work item text.
- Without an argument, the work item is read from stdin.

A work item without a non-empty line fails before the run starts. `--base` defaults to `main` and `--rounds`
defaults to 3.

Without `--repo`, the run uses the Git repository that contains the current directory. With `--repo`, the value is
first a path, relative to the current directory. If that path is the top level of a local Git repository, the run
uses it and its local `--base` commit. Otherwise `gh repo clone <value>` clones the repository into the run
directory, and the run starts from the cloned `origin/<base>`. A bare name such as `calibre` clones from the
authenticated user, and `owner/calibre` names the owner.

The command prints `run <run-id>`, then one progress line on stderr as each session starts: `plan`,
`round <n>: implement`, `round <n>: review` and `judge`.

The work item ships onto the branch `ship/<run-id>`, in a worktree in the run directory. The selected repository's
checkout, index and local edits stay unchanged. Ship does not push and does not open a pull request.

After each implement session, the run stages all changes in the worktree:

- If the staged tree matches the start commit, the run is blocked. It prints
  `blocked <subject> after <n> rounds: <worktree>` and the implementer's reply, and exits 1.
- Otherwise new staged changes become the commit `round <n>`. Commits that the implementer made are kept. A round
  without new changes still goes to review when earlier changes remain.

The review session gets the work item, the handoff, the implementer's reply, and the paths of the round's patches in
the run directory: `round-<n>.patch` from the start commit, and from round 2 `round-<n>-fix.patch` from the previous
round. Its challenge ends with SHIP or FIX. On FIX, its handoff gives the next round's instructions. A run that is
not shipped after `--rounds` rounds prints `stopped <subject> after <n> rounds: <worktree>` and exits 1.

On SHIP, the judge session reviews the change in the worktree, and the run squashes the work into one commit:

```text
Fix the README typo

# Fix the README typo

The README says wrold.

4 FAIL README.md:3 adds a line the work item does not need

Rounds: 2
Judge: 0.83
```

The subject is the first non-empty line of the work item without leading `#`. The body is the work item, then the
judge's failed answers. The judge answers eight questions with PASS or FAIL. If question 1 (complete) or 2 (correct)
fails, the score is 0. Otherwise the score is the fraction of questions 3 to 8 that pass. If the judge fails or its
reply misses an answer, the commit has no `Judge` trailer. The command prints
`shipped <subject> in <n> rounds, judge <score or failed>, <commit>` and exits 0.

Blocked and stopped runs keep their branch, worktree and round commits. Delete them when you no longer need them.

## Sessions

Every session (plan, implement, review and judge) uses `cursor/claude-opus-5-5` with thinking `medium` and gets the
same tools.

Sessions use Pi's providers and credentials from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), including the providers
that Pi extension packages register, such as `cursor`. Their system prompt has the `AGENTS.md` instructions and skills
that Pi loads for the worktree.

The tools are `read`, `grep`, `find`, `ls`, `write`, `edit` and `bash`, plus the tools of the packages in Pi's
settings that declare `"piDurable": { "extensions": [...] }`, such as pi-ipython and pi-rlm. Git packages and local
package directories are supported. Packages installed from npm are not supported, because Node does not strip types
from TypeScript files under `node_modules`. The run does not install missing packages, and it loads the packages
again at each resume. A package entry that fails to load fails the start or resume with `workflows: <error>`. Each
entry's `close()` runs when the command ends, also after Ctrl+C, and an error from it prints a `warning:` line.

## Resume

```sh
workflows ship resume <run-id>
workflows resume <run-id>
```

Both forms continue the run. `workflows resume` finds the workflow that the run saved, and `workflows ship resume`
refuses a run of another workflow.

Ctrl+C stops the run and keeps it resumable: the command prints `interrupted; continue with: workflows ship resume
<run-id>` and exits 130. A second Ctrl+C exits at once.

Resume opens the run's store and continues the pending work. It uses the work item, repository, start commit,
prompts, models and round limit that the run saved before it started. It does not read the work item file again,
select or clone the repository again, or create another branch. Answered turns are not sent to the model again. A
turn that was in progress is sent again.

A run that fails with an error prints `failed <subject>: <error>` and `continue with: workflows ship resume
<run-id>`, and exits 1. Examples are a failing Git hook, or a model error that remains after Pi's retries. Resume
runs the failed step again: a failed Git step runs again, and a failed turn is sent again in the same session.

A shipped, blocked or stopped run is final: resume prints the same result and exits with the same code.

Model requests use Pi's retry, stream timeout and compaction settings from its `settings.json`.

## Run directory

Runs live in `$XDG_STATE_HOME/workflows/runs/<run-id>`, by default `~/.local/state/workflows/runs/<run-id>`:

- `durable.sqlite`: the pi-durable store with the saved inputs, the sessions and the progress of the run
- `worktree/`: the worktree on `ship/<run-id>`
- `repository/`: the clone, for a GitHub repository only
- `round-<n>.patch`, `round-<n>-fix.patch`: the patches each review got

## Prompts

`prompts/` holds the Pi prompt templates `plan`, `challenge`, `handoff`, `implement`, `review` and `judge`. Edit the
wording there. Keep the frontmatter and the last line `$@`: the run removes them, then adds its inputs as
`## <name>` sections. The run adds the SHIP or FIX ending of the review challenge itself, so a template edit cannot
remove it. The judge rubric is fixed: its eight numbered answers make the score. A run uses the templates as they were
when it started.

## Development

```sh
npm run check
```

This runs Biome, the TypeScript check and Vitest. The tests use a fake model provider, a fake `gh`, and temporary Git
repositories. They do not call a real model or open Pi.
