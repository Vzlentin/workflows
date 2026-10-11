# workflows

`workflows ship` ships one work item onto a new branch through [Pi](https://github.com/earendil-works/pi) sessions.
`workflows campaign` splits a goal into work items and ships them one after another onto one branch.
`workflows optimize ship` searches for better ship prompts over a set of work items. The run is
headless and resumable. [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) runs the sessions,
model calls and tool calls, and stores the progress of the run.

`src/lib/` is the library that runs workflows: run directories, the durable store, sessions, retries, resume and
workflow scripts. `src/workflows/` holds the workflows built on it: `ship`, `campaign`, `optimize`, and `run`, which runs
a JavaScript workflow script. `ship` selects the repository and creates the worktree, then runs the workflow script
`workflows/ship.js` in the worktree for the sessions, the Git steps and the squash. `campaign` does the same with
`workflows/campaign.js`, which runs `workflows/ship.js` once for each work item.

```text
plan session:       plan  ->  challenge  ->  handoff
implement session:  implement the handoff                      <- round n (at most --rounds)
review session:     review  ->  challenge (SHIP or FIX)  ->  handoff (on FIX, back to implement)
judge session:      fixed rubric, after SHIP
```

Each box is a new session.

## Setup

Requires Node.js 22.19 or later, Git, and Pi credentials for the `anthropic` provider: log in once with `/login` in
`pi`, or set `ANTHROPIC_API_KEY`.
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

`--prompts <folder>`, relative to the current directory, gives prompts for this run: each `<name>.md` in the folder
replaces the package prompt `prompts/<name>.md`, in the same template format. A missing folder, or a file with no
package prompt of that name, fails before the run starts. The run saves the prompts that it used, as any run does.
`workflows optimize` uses this option. `campaign` does not take it.

Without `--repo`, the run uses the Git repository that contains the current directory. With `--repo`, the value is
first a path, relative to the current directory. If that path is the top level of a local Git repository, the run
uses it and its local `--base` commit. Otherwise `gh repo clone <value>` clones the repository into the run
directory, and the run starts from the cloned `origin/<base>`. A bare name such as `calibre` clones from the
authenticated user, and `owner/calibre` names the owner.

The command prints `run <run-id>`, then one progress line on stderr as each session starts: `plan`,
`round <n>: implement`, `round <n>: review` and `judge`. A resume prints the phase line of the first call that runs,
such as a turn or a Git step, and the lines after it.

The work item ships onto the branch `ship/<run-id>`, in a worktree in the run directory. The selected repository's
checkout, index and local edits stay unchanged. Ship does not push and does not open a pull request.

After each implement session, the run stages all changes in the worktree:

- If the staged tree matches the start commit, the run is blocked. It prints
  `blocked <subject> after <n> rounds: <worktree>` and the implementer's reply, and exits 1.
- Otherwise new staged changes become the commit `round <n>`. Commits that the implementer made are kept. A round
  without new changes still goes to review when earlier changes remain.

The review session gets the work item, the handoff, the implementer's reply, and the paths of the round's patches in
the run directory: `round-<n>.patch` from the start commit, and from round 2 `round-<n>-fix.patch` from the previous
round. Its challenge answers SHIP or FIX through `respond`. On FIX, its handoff gives the next round's instructions. A run that is
not shipped after `--rounds` rounds prints `stopped <subject> after <n> rounds: <worktree>` and exits 1.

The run keeps a memory of notes, which it only appends to. The planner's handoff, each implement turn and the
reviewer's handoff answer through `respond` with their text and a list of notes: the planner gives its decisions with
their reasons, the implementer gives what it tried and what it observed, and the reviewer gives the decisions of its
challenge, with the findings that it cut and why. The reviewer has no handoff on SHIP or on FIX in the last round, so
it gives no notes then. Each note becomes one line `#<k> <author> <round>: <note>`, with its whitespace collapsed,
where the author is `planner`, `implementer` or `reviewer`, and the planner's round is 0. When the memory has notes,
every prompt of the planner, implement and review sessions starts with a `## memory` section that lists them. The
judge's prompt has no memory. A resume builds the memory again from the saved answers, so it gives the same prompts.

The review challenge has an evidence rule: a finding that reverses a note, or a choice that the implementer explained,
stays only with a defect that the review showed, written as `reverses #k: <defect>`. `workflows/ship.js` adds this
rule next to the SHIP or FIX rule, and not in a template. The planner's challenge does not get it.

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
judge's findings. The judge answers through `respond`: eight PASS or FAIL answers, and one finding line for each failed
question. If question 1 (complete) or 2 (correct) fails, the score is 0. Otherwise the score is the fraction of
questions 3 to 8 that pass. If the judge fails or does not answer through `respond`, the commit has no `Judge` trailer,
and the command prints `judge failed on <subject>: <error>` on stderr. The command prints
`shipped <subject> in <n> rounds, judge <score or failed>, <commit>` and exits 0.

The result of the run, which `--json` prints, has `status` and `rounds`; `head` when shipped; `score`, `answers`, the
eight answers in question order, and `findings`, the finding lines that the commit message has, when the judge
answered; `judgeError` when the judge failed; `reply` when blocked; and `memory`, the memory lines in order or `[]` when
there are no notes, for every status.

Blocked and stopped runs keep their branch, worktree and round commits. Delete them when you no longer need them.

## Campaign

```sh
workflows campaign goal.md
workflows campaign --repo calibre --base develop --rounds 2 "Make the docs complete"
```

The goal comes from one argument or from stdin, as the work item of `ship` does, and `--repo`, `--base` and `--rounds`
work as for `ship`. `--rounds` applies to each work item. Errors name the goal, such as `the goal is empty`.

A planner session splits the goal into work items with the `split` prompt, and answers through `respond`. Then each
work item ships in turn, in one worktree on the branch `campaign/<run-id>`: the plan, the rounds, the review, the
judge and the squash of `workflows/ship.js`, from the commit that the item before it made. So each shipped item is one
commit, with the commit message of `ship`. No `ship/<run-id>` branch is made, and nothing is merged or pushed.

After each shipped item, also the last one, a new planner session gets the goal, the shipped item and the remaining
items with the `requeue` prompt. Its answer through `respond` is the new queue, which can be empty. The campaign ends
when the queue is empty. The queue has no length limit: a requeue can add items each time.

The command prints `run <run-id>`, then `item <n>: <subject>` on stderr before the progress lines of each item. A
resume can print the line of the item it continues after the first lines of that item.

- When the queue is empty, the command prints `done <subject> in <n> items, <commit>` with the commit of the last item,
  and exits 0.
- When an item is blocked or stopped, or ships with a judge score of 0, the campaign stops. The command prints
  `stopped <subject> at item <n>: <worktree>` and exits 1. A missing score, when the judge failed, does not stop it.

`<subject>` is the first non-empty line of the goal without leading `#`. The result is
`{ "status": "done", "head", "items": [{ "item", "result" }] }` or `{ "status": "stopped", "items" }`, with the `ship`
result of each item that ran. `head` is the commit of the last item.

## Optimize

```sh
workflows optimize ship --items items/
workflows optimize ship --items items/ --prompts review,handoff --trials 5
```

`workflows optimize ship` searches for better texts of some ship prompts with AxGEPA from
[Ax](https://github.com/ax-llm/ax). It never changes `prompts/`: the result is a diff to apply by hand.

The items folder, relative to the current directory, holds at least 2 work items as `<name>.md` files. Each file has
the frontmatter `repo`, the path of a local Git repository, relative to the items folder, and `start`, the commit that
ship starts from. Quote a commit that YAML can read as a number. The body is the work item.

```text
---
repo: ../calibre
start: "4dfb5c8"
---
# Fix the README typo

The README says wrold.
```

`--prompts` lists the prompts to optimize, separated by commas: any of `plan`, `challenge`, `handoff`, `implement` and
`review`. The default is `review,challenge,handoff`. `judge` gives the score, so it is never a candidate. `--trials`
defaults to 3. An unknown prompt name, fewer than 2 items, or an item without `repo` or `start` is bad usage.

A candidate is one text for each listed prompt, and the package texts are the baseline. Each evaluation runs
`workflows ship --repo <repo> --base <start> --prompts <candidate folder> --json -- <item body>` as a child process.
Evaluations run one at a time. The score of a shipped run is `passes/8 - 0.1*(rounds-1)`, where `passes` is the number
of PASS answers of the judge, or 0 when the judge failed. A blocked or stopped run scores 0. After a ship run finishes,
its worktree and its branch `ship/<run-id>` are removed. Its run directory stays.

Ax gets at most `trials × items` evaluations, and each batch is all the items. An evaluation that Ax asks again counts
against this limit. The best candidate is the one with the highest mean score among the evaluated candidates.

A new text comes from a turn of the `reflect` prompt in one session with the `default` agent profile, in the current
directory. The turn gets the prompt name, its current text, and for each item of the last batch the work item, the
score, the judge findings and the memory lines of the ship result. An empty reply, or a reply equal to the current
text, stops the optimization with an error.

The command prints `run <run-id>`, then `optimized ship: baseline <mean>, best <mean>, <path>` and exits 0. The means
are over the items, and `<path>` is `prompts.diff` in the run directory. That file starts with one line
`<item>: baseline <score>, best <score>` for each item, then the `git diff` from the package prompts to the best
candidate, which `git apply` takes in the checkout. When no candidate is better, the diff part is empty.

A ship run that does not finish, such as a failed or interrupted one, stops the optimization. The command prints
`failed ship: ship run <id> failed on <item>: <error>; continue with: workflows resume <id>` and
`continue with: workflows optimize resume <run-id>`, and exits 1. `workflows optimize resume <run-id>` runs Ax again
from the start. A finished evaluation of the same texts and item returns its saved result and starts no ship run, and
an unfinished one resumes its ship run. A reflect turn with the same prompt returns its saved answer. A hard kill of the
command while a ship run runs loses that ship run's ID, and the resume runs that item again in a new ship run.

## Sessions

The plan, implement, review and judge sessions use the agent profiles `agents/planner.md`, `agents/implementer.md`,
`agents/reviewer.md` and `agents/judge.md`. Each uses `anthropic/claude-opus-5-5` with thinking `medium`, and every
session gets the same tools. `ship` reads `workflows/ship.js`, the prompts and the profiles of the package only, not
the `.workflows/` folder of the project.

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
- Any other argument is a name in the `workflows/` folder of the package or of the project. An unknown name fails
  with `workflows: no workflow <name>` and exits 1.

`workflows/ship.js` stops with an error when it gets no `start` argument: `ship runs only through workflows ship or
workflows campaign, which give it the start commit`. Thus `workflows run ship` and `run("ship")` without `start` fail
before they change anything. The script does not check where `start` comes from: with `--arg start=<commit>`, it runs
in the current directory and can commit there.

The project folder is `.workflows/` at the root of the current directory's Git repository, or in the current
directory outside a repository. Like the package, it can hold `workflows/*.js`, `prompts/*.md` and `agents/*.md`. A
project file adds to the package files, and replaces the package file of the same name in the same folder.

`--arg <key>=<value>` gives the script `args.<key>` as a string, and can be repeated. A value without `=` or a key
given twice is bad usage: the command prints its usage and exits 2.

The command prints `run <run-id>` on stdout, then each `phase` and `log` line on stderr when the script's next call
runs, or when the script ends. When the script returns, the
command prints the return value on stdout and exits 0. A string prints as it is, and any other value prints as JSON.
With `--json`, stdout gets one JSON outcome line in place of the value. See [JSON output](#json-output).

A script that throws, or a call in it that fails, stops the run: the command prints `failed <name>: <error>` and
`continue with: workflows run resume <run-id>` on stderr, and exits 1. `<name>` is the file name without `.js`, the
workflow name, or `stdin`.

### The script API

A script is the body of an async function: top-level `await` and `return` work. Each call below is a durable call,
except `phase`, `log`, `args`, `prompts`, `parallel` and `pipeline`.

| Global | Meaning |
|---|---|
| `args` | The `--arg` values |
| `runId`, `runDir` | The run ID and the run directory. A script that `run()` starts gets the same values |
| `agent(prompt, { as, schema })` | One turn in a new session of profile `as` (default `default`). Returns the reply text, or the answer with `schema` |
| `session(profile)` | A new session of `profile` (default `default`). `.ask(prompt, { schema })` is one turn in it |
| `sh(cmd)` | Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell, and the error is `<program> <first argument> failed: <output>` |
| `ok(cmd)` | Runs `cmd` as `sh` does. Returns true when the exit code is 0 |
| `run(name, args)` | Runs the script `name` of `workflows/` in the package or the project and returns its result |
| `tools.<name>(args)` | Any tool that sessions get, such as `tools.read({ path })` |
| `prompts.<name>(inputs)` | The instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section |
| `parallel(thunks)` | Runs the functions at once and returns their results |
| `pipeline(items, ...stages)` | Sends each item through the stages in order, and the items at once |
| `phase(title)`, `log(text)` | Write one line on stderr before the script's next call that runs |

With `schema`, a JSON Schema, the session gets a `respond` tool for that turn. The model gives its answer as
`respond({ answer })`, which ends the turn, and the call returns the checked answer. The schema goes to the model as
JSON in the `answer_schema` system prompt section, and the prompt goes unchanged. A string answer that does not match
the schema is parsed as JSON, and a parsed object or array is checked instead, so an object sent as its JSON text is
accepted. A string answer to a string schema, such as SHIP or FIX, stays a string. An answer that does not match the
schema goes back to the model as an error, and the model tries again.

The script runs in the pi-codemode sandbox, with no time limit. It has no file system, network, modules or timers.
Effects go through `sh`, `ok` and `tools`. `Date`, `Date.now()` and `Math.random()` throw, so that a script makes
the same calls each time it runs.

### Agent profiles

`agents/<name>.md` is the profile of `agent(..., { as: name })` and `session(name)`. Its frontmatter gives `model`
as `<provider>/<id>` and `thinking`. Its body, without frontmatter, is added to the session's system prompt. Every
profile gets the same tools as the ship sessions. `agents/default.md` uses `anthropic/claude-opus-5-5` with thinking
`medium`.

### Saved inputs and resume

Before the run starts, it saves the script, every `workflows/*.js` of the package and the project, the instructions
of every prompt, every profile, the args and the current directory. Resume and `run()` use these saved inputs, so a
later edit of a script, prompt or profile, in the package or in `.workflows/`, changes only new runs.

Resume runs the script again from the top. A call that succeeded before returns its saved result, and is not run
again. A call is known by its tool, its arguments and its position among identical calls. A turn that was in progress
continues in its session. A command that was in progress runs again, so commands must be safe to repeat. Every call
that failed runs again, also one that the script caught. `phase` and `log` lines are not saved. A resume prints the
phase line of the first call that runs, and the lines after it. A call that returns a saved result drops the `log`
lines before it, and keeps the last `phase` line waiting for the next call that runs.

## Resume

```sh
workflows ship resume <run-id>
workflows run resume <run-id>
workflows resume <run-id>
```

Each form continues the run. `workflows resume` finds the workflow that the run saved, and `workflows ship resume`
or `workflows run resume` refuses a run of another workflow.

Ctrl+C stops the run and keeps it resumable: the command prints `interrupted; continue with: workflows <workflow>
resume <run-id>` and exits 130. Ctrl+C also stops a Git step that is running, and resume runs that step again. A
second Ctrl+C exits at once.

Resume opens the run's store and continues the pending work. For `run`, see [Saved inputs and
resume](#saved-inputs-and-resume). For `ship`, it uses the work item, repository, start commit, `workflows/ship.js`,
prompts, profiles and round limit that the run saved before it started. `campaign` does the same with its goal and
`workflows/campaign.js`: the split, the shipped items and the requeues are not run again. It does not read the work
item file again, select or clone the repository again, or create another branch. Answered turns are not sent to the
model again. A turn that was in progress is sent again.

A run that fails with an error prints `failed <subject>: <error>` and `continue with: workflows ship resume
<run-id>`, and exits 1. Examples are a failing Git hook, or a model error that remains after Pi's retries. Resume
runs the failed step again: a failed Git step runs again, and a failed turn is sent again in the same session.

A shipped, blocked or stopped run is final: resume prints the same result and exits with the same code.

A ship run saved before `ship` ran `workflows/ship.js` cannot resume: resume prints
`workflows: run <run-id> was saved by an earlier version of ship and cannot resume` and exits 1.

Model requests use Pi's retry, stream timeout and compaction settings from its `settings.json`.

## JSON output

```sh
workflows ship --json plan.md
workflows resume <run-id> --json
```

Every form of start and resume accepts `--json`, at any position before `--`. After `run <run-id>`, stdout gets one
line of JSON in place of the report lines, `{ "runId", "status", "result"?, "report"?, "error"? }`, for every outcome:

- `finished`: `result` is the result of the run, for example `{"status":"shipped","rounds":1,"head":"1a2b3c4",...}`
  for ship. The [Ship](#ship) section lists the fields of a ship result. `report` is the list of report lines that
  the command prints without `--json`, such as `["shipped Fix the README typo in 1 rounds, judge 1.00, 1a2b3c4"]`.
- `failed`: `error` is the error message.
- `interrupted`: Ctrl+C stopped the run.

The JSON line replaces the `failed`, `continue with` and `interrupted` lines on stderr, so each stderr line is a
`phase` or `log` line of the run, or a warning. The exit codes do not change. An error before the run exists, such as
bad usage, prints no `run <run-id>` line and no JSON line.

## List

```sh
workflows list
workflows list --json
```

`workflows list` prints one line for each run in the runs directory, newest run ID first: `<run-id> <workflow>
<status> <title>`. The title is the subject of the work item for ship, the subject of the goal for campaign, and the
script name for `run`. A finished ship run has the status of its result: `shipped`, `blocked` or `stopped`. A finished
campaign has `done` or `stopped`. A finished `run` has the status `done`. Any other run, also a failed one, is
`unfinished`. With `--json`, the command prints one JSON array of `{ "runId", "workflow", "title", "status" }`.

`list` only reads the stores. It does not load Pi packages, and no run continues.

## Pi package

The package is also a Pi package. Its `pi` field in `package.json` declares the extension `extensions/workflows.ts`
and the skill `skills/workflows/SKILL.md`. Add it to Pi from its Git URL, like other Pi packages:

```sh
pi install https://github.com/Vzlentin/workflows
```

Update it with:

```sh
pi update --extension https://github.com/Vzlentin/workflows
```

The Pi package needs no build. Pi installs the dependencies, and the extension runs the CLI from its TypeScript
source. Node strips the types, because a git package is not under `node_modules`. The `workflows` command on the
PATH still needs `npm run build` in a checkout, because its `bin` is `dist/cli.js`. See [Setup](#setup).

The extension runs each workflow as a child process of this package's `node src/cli.ts`, in the session's directory,
always with `--json`. So a run that starts in Pi is a normal run in the runs directory, and `workflows resume`
continues it from a terminal. The child process runs outside Pi, so the package has its own copies of `pi-ai` and
`pi-coding-agent` as optional dependencies, which Pi's git install keeps.

### The `workflow` tool

The tool takes one of `name`, `script` or `resume`, plus `args`:

- `name: "ship"` runs `workflows ship`. `args.item` is the work item, and each other arg becomes `--<key>=<value>`,
  such as `--rounds=2`. An arg that `ship` does not know is bad usage, so no run starts.
- `name: "campaign"` runs `workflows campaign` in the same way, with `args.goal` as the goal.
- Any other `name` runs `workflows run <name>`. Each arg becomes `--arg <key>=<value>`: a string as it is, any other
  value as its JSON text. The script gets every arg as a string, so `{ depth: 2 }` reaches it as `"2"`.
- `script` runs `workflows run -` with the script on stdin.
- `resume` runs `workflows resume <run-id>`.

Each stderr line of the run is a progress update of the tool. Esc sends SIGINT to the run, as Ctrl+C does, so the run
stays resumable.

In Pi, the call line is `workflow ship <slug>`, `workflow campaign <slug>`, `workflow <name>`, `workflow script` or
`workflow resume <run-id>`. The slug is the file name of a `.md` item or goal without `.md`, or else the first 40
characters of its subject. Under it, each stderr line is a step: `✓` for a step that is done, `◉` for the step that
runs now, and `✗` for the step where the run failed or was interrupted. A finished run ends with its `report` lines,
such as `shipped Fix the README typo in 2 rounds, judge 1.00, 4dfb5c8`. A failed or interrupted run ends with the
error and the run ID to resume. The steps are in the `details` of each update and of the result, so the list draws the
same after a reload. The model gets the same result text as before.

The tool declares an `outputSchema`. Its `structuredContent` is `{ runId, status, result?, report?, error? }`:

- `finished`: the run finished, `result` is its result, such as a `blocked` ship result, and `report` is its report
  lines.
- `failed`: the run failed, and `error` is its error message.
- `interrupted`: Esc stopped the run.

These are the fields of the JSON outcome line of the command.

A failed or interrupted result is an error result that keeps `structuredContent`. Thus
`await tools.workflow({ name: "ship", args: { item } })` in a codemode script gets this object. A call that fails
before a run exists, such as an unknown workflow name, is a normal tool error with the stderr text.

### `/workflows`

`/workflows` prints the output of `workflows list` in the session. `/workflows resume <run-id>` does not run the
command. It sends a user message that asks the agent to continue the run with the `workflow` tool, so that Esc and the
progress updates work as for any tool call. When the agent is busy, the message waits as a follow-up.

## Run directory

Runs live in `$XDG_STATE_HOME/workflows/runs/<run-id>`, by default `~/.local/state/workflows/runs/<run-id>`:

- `durable.sqlite`: the pi-durable store with the saved inputs, the sessions and the progress of the run

A ship run also has:

- `worktree/`: the worktree on `ship/<run-id>`
- `repository/`: the clone, for a GitHub repository only
- `round-<n>.patch`, `round-<n>-fix.patch`: the patches each review got

A campaign run has `worktree/` on `campaign/<run-id>` and `repository/` in the same way, plus:

- `item-<n>/`: the `round-<n>.patch` and `round-<n>-fix.patch` files of item `n`

An optimize run has:

- `evaluations.json`: each evaluation by the hash of the candidate texts and the item, with its ship run ID and, once
  it finished, its result
- `candidates/<hash>/`: the `<name>.md` files of each candidate, which ship gets as `--prompts`
- `diff/`: the package templates (`a/prompts/`) and the best candidate (`b/prompts/`) that `prompts.diff` compares
- `prompts.diff`: the score lines and the diff

## Prompts

`prompts/` holds the Pi prompt templates `plan`, `challenge`, `handoff`, `implement`, `review` and `judge`,
`split` and `requeue` for `campaign`, and `reflect` for `optimize`. Edit the wording there. Keep the frontmatter and the last line `$@`: the run
removes them, then adds its inputs as `## <name>` sections. `workflows/ship.js` adds the evidence rule and the SHIP or
FIX answer rule of the review challenge itself, so a template edit cannot remove them. It also adds the `respond`
answer rules of the handoff and implement turns. In the same way, `workflows/campaign.js` adds the `respond` answer rule of `split` and
`requeue`. The judge rubric is fixed: its eight answers, in question order, make the score. A run uses the templates
as they were when it started.

Workflow scripts get every template of `prompts/` as `prompts.<name>`, and the agent profiles of `agents/`. A run
uses the profiles as they were when it started.

## Development

```sh
npm run check
```

This runs Biome, the TypeScript check and Vitest. The tests use a fake model provider, a fake `gh`, a fake
`workflows` command for the extension, and temporary Git repositories. They do not call a real model or open Pi.
