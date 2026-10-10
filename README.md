# workflows

`workflows ship` ships one work item onto a new branch through [Pi](https://github.com/earendil-works/pi) sessions.
The run is headless and resumable. [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) runs the
sessions, model calls and tool calls, and stores the progress of the run.

`src/lib/` is the library that runs workflows: run directories, the durable store, sessions, retries, resume and
workflow scripts. `src/workflows/` holds the workflows built on it: `ship`, and `run`, which runs a JavaScript workflow
script.

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

## Run

```sh
workflows run review --arg path=src/lib
workflows run ./fix.js --arg item="Fix the README typo"
cat fix.js | workflows run - --json
```

`workflows run` runs one workflow script. The script comes from one argument:

- `-` reads the script from stdin.
- An argument that ends in `.js` or contains `/` is a file, relative to the current directory. A missing file is an
  error.
- Any other argument is a name in the package's `workflows/` folder. An unknown name fails with
  `workflows: no workflow <name>` and exits 1.

`--arg <key>=<value>` gives the script `args.<key>` as a string, and can be repeated. A value without `=` or a key
given twice is bad usage: the command prints its usage and exits 2.

The command prints `run <run-id>` on stdout, then each `phase` and `log` line on stderr. When the script returns, the
command prints the return value on stdout and exits 0. A string prints as it is, and any other value prints as JSON.
With `--json`, the value always prints as JSON.

A script that throws, or a call in it that fails, stops the run: the command prints `failed <name>: <error>` and
`continue with: workflows run resume <run-id>` on stderr, and exits 1. `<name>` is the file name without `.js`, the
workflow name, or `stdin`.

### The script API

A script is the body of an async function: top-level `await` and `return` work. Each call below is a durable call,
except `phase`, `log`, `args`, `prompts`, `parallel` and `pipeline`.

| Global | Meaning |
|---|---|
| `args` | The `--arg` values |
| `agent(prompt, { as, schema })` | One turn in a new session of profile `as` (default `default`). Returns the reply text, or the answer with `schema` |
| `session(profile)` | A new session of `profile` (default `default`). `.ask(prompt, { schema })` is one turn in it |
| `sh(cmd)` | Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a nonzero exit code |
| `ok(cmd)` | Runs `cmd` as `sh` does. Returns true when the exit code is 0 |
| `run(name, args)` | Runs the script `name` of the package's `workflows/` and returns its result |
| `tools.<name>(args)` | Any tool that sessions get, such as `tools.read({ path })` |
| `prompts.<name>(inputs)` | The instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section |
| `parallel(thunks)` | Runs the functions at once and returns their results |
| `pipeline(items, ...stages)` | Sends each item through the stages in order, and the items at once |
| `phase(title)`, `log(text)` | Write one line on stderr |

With `schema`, a JSON Schema, the session gets a `respond` tool for that turn. The model gives its answer as
`respond({ answer })`, which ends the turn, and the call returns `answer`. An answer that does not match the schema
goes back to the model as an error, and the model tries again.

The script runs in the pi-codemode sandbox, with no time limit. It has no file system, network, modules or timers.
Effects go through `sh`, `ok` and `tools`. `Date`, `Date.now()` and `Math.random()` throw, so that a script makes
the same calls each time it runs.

### Agent profiles

`agents/<name>.md` is the profile of `agent(..., { as: name })` and `session(name)`. Its frontmatter gives `model`
as `<provider>/<id>` and `thinking`. Its body, without frontmatter, is added to the session's system prompt. Every
profile gets the same tools as the ship sessions. `agents/default.md` uses `cursor/claude-opus-5-5` with thinking
`medium`.

### Saved inputs and resume

Before the run starts, it saves the script, every `workflows/*.js` of the package, the instructions of every prompt,
every profile, the args and the current directory. Resume and `run()` use these saved inputs, so a later edit of a
script, prompt or profile changes only new runs.

Resume runs the script again from the top. A call that succeeded before returns its saved result, and is not run
again. A call is known by its tool, its arguments and its position among identical calls. A turn that was in progress
continues in its session. A command that was in progress runs again, so commands must be safe to repeat. Every call
that failed runs again, also one that the script caught. `phase` and `log` lines are not saved, so resume prints them
again.

## Resume

```sh
workflows ship resume <run-id>
workflows run resume <run-id>
workflows resume <run-id>
```

Each form continues the run. `workflows resume` finds the workflow that the run saved, and `workflows ship resume`
or `workflows run resume` refuses a run of another workflow.

Ctrl+C stops the run and keeps it resumable: the command prints `interrupted; continue with: workflows <workflow>
resume <run-id>` and exits 130. A second Ctrl+C exits at once.

Resume opens the run's store and continues the pending work. For `run`, see [Saved inputs and
resume](#saved-inputs-and-resume). For `ship`, it uses the work item, repository, start commit,
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

A ship run also has:

- `worktree/`: the worktree on `ship/<run-id>`
- `repository/`: the clone, for a GitHub repository only
- `round-<n>.patch`, `round-<n>-fix.patch`: the patches each review got

## Prompts

`prompts/` holds the Pi prompt templates `plan`, `challenge`, `handoff`, `implement`, `review` and `judge`. Edit the
wording there. Keep the frontmatter and the last line `$@`: the run removes them, then adds its inputs as
`## <name>` sections. The run adds the SHIP or FIX ending of the review challenge itself, so a template edit cannot
remove it. The judge rubric is fixed: its eight numbered answers make the score. A run uses the templates as they were
when it started.

Workflow scripts get every template of `prompts/` as `prompts.<name>`, and the agent profiles of `agents/`. A run
uses the profiles as they were when it started.

## Development

```sh
npm run check
```

This runs Biome, the TypeScript check and Vitest. The tests use a fake model provider, a fake `gh`, and temporary Git
repositories. They do not call a real model or open Pi.
