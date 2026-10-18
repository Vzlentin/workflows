# workflows

`workflows ship` ships one work item onto a new branch through [Pi](https://github.com/earendil-works/pi) sessions.
`workflows campaign` splits a goal into work items and ships them one after another onto one branch.
`workflows optimize ship` searches for better ship prompts over a set of work items. The run is
headless and resumable. It runs in the [harness](https://github.com/Vzlentin/harness) host of its project, whose
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) store keeps the sessions, model calls, tool
calls and the progress of the run. See [Runs in the harness host](#runs-in-the-harness-host).

`src/` is the engine that runs workflows: run directories, the script task, sessions, retries, resume and
workflow scripts. Every workflow script is a command: `workflows <wf>` runs `workflows/<wf>.js`, and the `meta` at
the top of the script declares its arguments. See [Workflow scripts](#workflow-scripts). `workflows/ship.js` and
`workflows/campaign.js` are scripts of the package. `ship` selects the repository and creates the worktree, through its
`meta`, then runs in the worktree for the sessions, the Git steps and the squash. `campaign` does the same, and runs
`workflows/ship.js` once for each work item. `workflows/optimize.js` runs `workflows/ship.js` once for each candidate
and work item.

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
pi install "$PWD"
node dist/cli.js ship plan.md
```

`npm link` installs the `workflows` command from this checkout. Runs execute in the harness host, which loads
workflows as a Pi package, so Pi's settings must list the checkout (`pi install <dir>`) or the
[Pi package](#pi-package). Otherwise a start fails with `workflows: Unknown task kind: workflows.run: the harness host
does not load workflows; add it to Pi with pi install`, and no run directory stays.

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
`campaign` and `optimize` take the same option.

Without `--repo`, the run uses the Git repository that contains the current directory. With `--repo`, the value is
first a path, relative to the current directory. If that path is the top level of a local Git repository, the run
uses it and its local `--base` commit. Otherwise `gh repo clone <value>` clones the repository into the run
directory, and the run starts from the cloned `origin/<base>`. A bare name such as `calibre` clones from the
authenticated user, and `owner/calibre` names the owner.

The command prints `run <run-id>`, then one progress step on stderr as each session starts: `plan`,
`round <n>: implement`, `round <n>: review` and `judge`. See [Progress](#progress) for how the steps show. A resume
prints the phase line of the first call that runs, such as a turn or a Git step, and the lines after it.

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

The goal comes from one argument or from stdin, as the work item of `ship` does, and `--repo`, `--base`, `--rounds`
and `--prompts` work as for `ship`. `--rounds` applies to each work item. Errors name the goal, such as `the goal is empty`.
When the judge of an item fails, the command prints `judge failed on <item subject>: <error>` on stderr, as `ship` does.

A planner session splits the goal into work items with the `split` prompt, and answers through `respond`. Then each
work item ships in turn, in one worktree on the branch `campaign/<run-id>`: the plan, the rounds, the review, the
judge and the squash of `workflows/ship.js`, from the commit that the item before it made. So each shipped item is one
commit, with the commit message of `ship`. No `ship/<run-id>` branch is made, and nothing is merged or pushed. Each
item is a ship child run, with its own run ID and run directory, in the store of the campaign run: see `run` in
[the script API](#the-script-api).

After each shipped item, also the last one, a new planner session gets the goal, the shipped item and the remaining
items with the `requeue` prompt. Its answer through `respond` is the new queue, which can be empty. The campaign ends
when the queue is empty. The queue has no length limit: a requeue can add items each time.

The command prints `run <run-id>`, then the step `item <n>/<total>: <subject>` on stderr before the steps of each item.
`<total>` is the number of items known when the item starts: the shipped items, this item and the queue. A requeue can
change it. The steps of the item's ship run are under the item step, indented by 2:

```text
✓ item 1/2: Fix the README typo
  ✓ plan
  ✓ round 1: implement
  ✓ round 1: review
  ✓ judge
◉ item 2/2: Add a thanks line
  ◉ plan
```

See [Progress](#progress). At resume, the first steps of the item it continues can come before the item step. On a
terminal and in Pi they move under the item step when it comes.

- When the queue is empty, the command prints `done <subject> in <n> items, <commit>` with the commit of the last item,
  and exits 0.
- When an item is blocked or stopped, or ships with a judge score of 0, the campaign stops. The command prints
  `stopped <subject> at item <n>: <worktree>` and exits 1. A missing score, when the judge failed, does not stop it.

`<subject>` is the first non-empty line of the goal without leading `#`. The result is
`{ "status": "done", "head", "items": [{ "item", "result" }] }` or `{ "status": "stopped", "items" }`, with the `ship`
result of each item that ran, and its child run ID as `result.runId`. `head` is the commit of the last item.

## Optimize

```sh
workflows optimize ship --items items/
workflows optimize --workflow ship --items items/ --improve review,handoff --trials 5
```

`workflows optimize ship` searches for better texts of some ship prompts with a reflective loop. It never changes
`prompts/`: the result is a diff to apply by hand. It is the package script `workflows/optimize.js`. The workflow to
optimize, `ship`, is one argument or `--workflow`, and defaults to `ship`.

The items folder, relative to the current directory, holds at least 2 work items as `<name>.md` files. Each file has
the frontmatter `repo`, the path of a local Git repository, relative to the items folder unless it is absolute, and
`start`, the commit that ship starts from. Quotes around a value are removed. The body is the work item.

```text
---
repo: ../calibre
start: "4dfb5c8"
---
# Fix the README typo

The README says wrold.
```

`--improve` lists the prompts to optimize, separated by commas: any of `plan`, `challenge`, `handoff`, `implement` and
`review`. The default is `review,challenge,handoff`. `judge` gives the score, so it is never a candidate. `--trials`
is the number of candidates that the run evaluates, the baseline included, and defaults to 3. A workflow other than
`ship`, an unknown prompt name, fewer than 2 items, or an item without `repo` or `start` fails the run after
`run <run-id>`, with `failed optimize: <error>`, and exits 1, because the script checks them when it runs.

A candidate is one text for each listed prompt. The baseline is the texts of the run's prompts, so `--prompts
<folder>` sets it. Each evaluation is the child run
`run("ship", { item, repo, base: start, prompts: candidate })`, one at a time. The score of a shipped run is
`passes/8 - 0.1*(rounds-1)`, where `passes` is the number of PASS answers of the judge, or 0 when the judge failed. A
blocked or stopped run scores 0. After a ship run finishes, its worktree and its branch `ship/<run-id>` are removed.
Its run directory stays. There is no evaluation cache: a reflect text equal to an earlier candidate's text ships again.

The run evaluates the baseline on every item first. Each later trial changes one prompt of the best candidate so far,
the listed prompts in turn, and evaluates the new candidate on every item. So the run makes `trials × items` ship
runs. A new candidate becomes the best one only when its mean score is higher, so the baseline stays on a tie.

A new text comes from a turn of the `reflect` prompt in a new session with the `default` agent profile, in the current
directory. The turn gets the prompt name, its text in the best candidate, and for each item the work item, the score,
the judge findings and the memory lines of the ship result of the best candidate. An empty reply, or a reply equal to
the current text, stops the optimization with an error.

The command prints `run <run-id>`, then `optimized ship: baseline <mean>, best <mean>, <path>` and exits 0. The means
are over the items, and `<path>` is `prompts.diff` in the run directory. That file starts with one line
`<item>: baseline <score>, best <score>` for each item, then `git diff --no-index --no-prefix baseline best` of the
run directory. When no candidate is better, the diff part is empty. The result is `{ baseline, best, diff }`: the two
means and the path.

A ship child run that fails stops the optimization with `failed optimize: child run <id> failed: <error>`, as any
failed `run()` call does. `workflows resume <run-id>` runs the script again: the finished ship runs and reflect turns
return their saved results, and the failed ship run continues. `workflows list` shows only the optimize run.

## Sessions

The plan, implement, review and judge sessions use the agent profiles `agents/planner.md`, `agents/implementer.md`,
`agents/reviewer.md` and `agents/judge.md`. Each uses `anthropic/claude-opus-5-5` with thinking `medium`, and every
session gets the same tools. Like every workflow script, `ship` and `campaign` read the scripts, prompts and profiles
of the package and of the project folder `.workflows/` of the current directory, also when `--repo` selects another
repository. See [Workflow scripts](#workflow-scripts). A project `agents/planner.md`, for example, gives the planner
another model.

Sessions are children of harness's children library in the harness host of the run's project, and use the host's
providers and credentials: Pi's, from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), including the providers that Pi
extension packages register, such as `cursor`. Their system prompt has the `AGENTS.md` instructions and skills that Pi
loads for the worktree, as harness gives its children: project skills only in a project that Pi trusts.

The tools are `read`, `grep`, `find`, `ls`, `write`, `edit` and `bash`, harness's `subagent` tool, and the tools of
the packages in Pi's settings that declare `"piDurable": { "extensions": [...] }`, such as pi-ipython and pi-rlm. The
host loads these packages once, when it starts, so a package installed later reaches the runs of a project after its
host restarts. A subagent that a session spawns is a child of that session.

A session of a run is at depth 1 of harness's tree of children, under the run, and its subagents at depth 2, the
deepest that harness allows.

## Workflow scripts

```sh
workflows                                  # lists the workflows
workflows review --path src
workflows ship --help
workflows ./fix.js "Fix the README typo"
cat fix.js | workflows - --json
workflows check review
```

`workflows <wf>` runs one workflow script. The first word selects it:

- `-` reads the script from stdin.
- A word that ends in `.js` or contains `/` is a file, relative to the current directory. A missing file is an
  error.
- Any other word is a name: `<wf>.js` in `workflows/` of the project folder first, then of the package. A project
  script replaces a package script of the same name. An unknown name fails with `workflows: unknown command <name>`
  and exits 2.

`resume`, `stop`, `list`, `show`, `save` and `check` are commands, so no script of these names can run. Bad usage of a
command prints `workflows: <error>`, then `usage:` and the usage line of that command, such as `usage: workflows
show <run-id> [--json]`, and exits 2.

The project folder is `.workflows/` at the root of the current directory's Git repository, or in the current
directory outside a repository. Like the package, it can hold `workflows/*.js`, `prompts/*.md` and `agents/*.md`. A
project file adds to the package files, and replaces the package file of the same name in the same folder.

`workflows` without arguments prints one line `<name>: <description>` for each script, or `<name>` for a script
without `meta.description`.

### `meta`

A script declares its command line in `export const meta = { ... }`, after its leading comments and before any other
code. `meta` is an object literal. The command evaluates it alone, in the sandbox, and does not run the script. The
script runs without `export`, so it can read `meta`. A script without `meta` takes no arguments.

```js
export const meta = {
  description: "Ship one work item onto a new branch.",
  args: {
    item: { type: "text", positional: true, label: "work item", required: true },
    rounds: { type: "number", default: 3 },
  },
  worktree: true,
  exit: { blocked: 1, stopped: 1 },
}
```

- `description` is one line for `workflows` and `--help`, like the `description` in the frontmatter of the profiles
  and prompts. It is a string.
- `args` gives each argument a `type`, and optionally `default`, `required`, `positional` and `label`:
  - `string` is the value as given. `number` is a positive integer; any other value fails with
    `--<name> must be a positive integer`. `boolean` is a flag without a value, false when not given.
  - `text` is a `.md` file, inline text, or stdin when the argument is not given, with the rules of the work item of
    [Ship](#ship). Errors name the `label`, such as `missing work item` or `the work item is empty`. A `text`
    argument that is not `required` and has no `default`, no value and no stdin is not in `args`.
  - At most one argument is `positional`. It also works as `--<name>`; giving it both ways is bad usage. Two
    positional values fail with `give the <label> as one argument`.
  - A `required` argument without a value fails with `missing <label>`. `label` defaults to the argument name.
- `worktree: true` adds `--repo` and `--base`, with the rules of [Ship](#ship). The run gets a new worktree on the
  branch `<wf>/<run-id>` in the run directory, runs the script there, and gives it `args.start`, the start commit.
- `exit` maps `result.status` to the exit code. Any other status, or a result without `status`, exits 0.

Every script also takes `--prompts <folder>`, as `ship` does, `--json` and `--help`. `workflows <wf> --help` prints
the usage line, built from `meta`, and `meta.description` when the script has one, and exits 0. Any other flag is bad usage. Bad usage prints
`workflows: <error>` and the usage line of the script, and exits 2. A bad `meta` fails with
`workflows: <name>: <problem>` and exits 1.

Before the run starts, the command scans the script for prompt calls, `prompts.<name>(`. A name without a template
fails with `<name> uses prompts.<prompt>, which has no template`. Other text such as `prompts.diff` in a path is not a
call, and a dynamic call such as `prompts[name]()` is not scanned.

`workflows check <wf>` reads and checks `meta`, the scanned prompts, and the agent profiles of each literal
`session("<profile>")` and `as: "<profile>"`. It also checks each object literal with a string `provider` or `model`,
with the profile of its `as` (default `default`) for the field that it leaves out, against Pi's model registry: Pi's
`models.json` and the providers that Pi and its packages register. Only an object literal that the script passes to
`session(...)` or `agent(...)` counts, without its inner objects. A model that the registry does not have fails with
`<name> uses the model <provider>/<id>, which Pi's model registry does not have`. A field whose value is not a string
literal, or an object with a spread, is checked when the session opens. `check` prints `ok <name>` and exits 0, or prints the first problem and
exits 1. It starts no run and writes nothing.

### Output

The command prints `run <run-id>` on stdout, then each `phase` and `log` line on stderr when the script's next call
runs, or when the script ends. The script runs in the host, which saves these lines in the project store, and the
command reads them from the store file about every 0.5 s. See [Progress](#progress). When the script returns a result with `report`, a list of lines, the command prints
those lines on stdout. Otherwise it prints the return value: a string as it is, and any other value as JSON. The exit
code comes from `meta.exit`. With `--json`, stdout gets one JSON outcome line in place of the lines. See
[JSON output](#json-output).

A script that throws, or a call in it that fails, stops the run: the command prints `failed <title>: <error>` and
`continue with: workflows resume <run-id>` on stderr, and exits 1.

### Progress

The `phase` and `log` lines of a run make a tree of steps. Each `phase` line is a step of its run, and the step before
it in the same run is done. Each `log` line is under the current step of its run, or at the level of its run before
the first step. A child run is under the step of its caller that is current when its first line comes, indented by 2.
When the caller has no step then, the child run moves under the caller's next step. The command draws the tree on
stderr in one of three ways:

- On a terminal, the command draws the tree again in place at each change. A step is `◉` while it runs, `✓` when it
  is done, and `✗` when its run failed or was stopped. Each line is cut to the width of the terminal. When another
  line, such as a warning, comes between two draws, the lines above it stay, and the changed lines print again below
  it.
- When stderr is not a terminal, and without `--json`, each step and log line prints once as it comes, with its indent
  and without a mark.
- With `--json`, each change prints one stderr line `{"progress":["<line>",...]}` with every line of the tree, each
  step as `<indent><mark> <text>` and each log line as `<indent><text>`. A run without steps prints no progress line.
  The [Pi tool](#the-workflow-tool) draws the last of these lines, so Pi shows the same steps as a terminal.

When the run ends, the steps that still run become `✓` when the run finished, and `✗` when it failed or was
stopped. A command that Ctrl+C detaches leaves them as they are. On a terminal and with `--json`, the tree draws once
more then. A command that follows a run shows only the lines that come after it starts or reaches the run. `<title>`
is the subject of the first `text` argument, or else the file name without `.js`, the workflow name, or `stdin`. The
run's task ends as failed, and its saved calls stay in the project store for the resume. `workflows show <run-id>` shows the failed call. See [Show](#show).

`workflows/ship.js` stops with an error when it gets no `start` argument: `ship runs only through workflows ship or
workflows campaign, which give it the start commit`. `run("ship", { repo })` gets its own worktree and `start`, as
`workflows ship` does. `run("ship")` without `repo` runs in the caller's directory and needs `start` from the caller.
The script does not check where `start` comes from: with `start` from another script, it runs in that script's
directory and can commit there.

### Child runs

`run(name, args)` starts a child run of the script `name` of the caller's saved scripts. The child run has its own run
ID and run directory, but no `project` file: it is a child task of the caller's task. So `workflows list` does not show
it, and `workflows resume <child-id>` prints `workflows: no run <child-id> in <runs>`. A resume of the caller
continues it. It runs in the same host, and its `phase` and `log` lines go to the same stderr, under the caller's
current step: see [Progress](#progress). It prints no `run` or report line. Its sessions belong to the child run, and
its end ends them as the end of a run does: see [Runs in the harness host](#runs-in-the-harness-host).

- The child's args are the defaults of its `meta.args`, then `args`, without `repo`, `base` and `prompts`. They are not
  checked against `meta`, so an undeclared arg reaches the script.
- With `meta.worktree` and `args.repo`, the child gets a new worktree on `<name>/<child-id>` in its run directory, in
  the repository of `args.repo` from the caller's directory, at `args.base` (default `main`), and `args.start`. Without
  `args.repo`, or without `meta.worktree`, the child runs in the caller's directory, and `start` is an ordinary arg.
- `args.prompts` maps prompt names to template texts. Each text, without frontmatter and the last `$@`, replaces that
  prompt in the child run only. A name with no prompt fails the call.
- The child run gets the caller's saved scripts, prompts and profiles.

`run()` returns the child's result, with `runId`, the child run ID, added to an object result. A failed child run
fails the call with `child run <id> failed: <error>`, and the child's task ends as failed. A caller that fails aborts
its child runs that are still running. A resume of the caller continues the same child run, with the same run ID and
run directory, also after a failed call, an abort or an interruption, and repeats no call that the child run saved. A
child run that ended without a result continues in a new task.

### The script API

A script is the body of an async function: top-level `await` and `return` work. Each call below is a durable call,
except `phase`, `log`, `args`, `prompts`, `parallel` and `pipeline`.

| Global | Meaning |
|---|---|
| `args` | The argument values of `meta.args`, and `start` with `worktree: true` |
| `runId`, `runDir` | The run ID and the run directory. A script that `run()` starts gets its own values |
| `agent(prompt, { as, provider, model, thinking, schema })` | One turn in a new session of profile `as` (default `default`), with the model of [Agent profiles](#agent-profiles). Returns the reply text, or the answer with `schema` |
| `session(profile)`, `session({ as, provider, model, thinking })` | A new session of the profile (default `default`), with the model of [Agent profiles](#agent-profiles). `.ask(prompt, { schema })` is one turn in it |
| `sh(cmd)` | Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell, and the error is `<program> <first argument> failed: <output>` |
| `ok(cmd)` | Runs `cmd` as `sh` does. Returns true when the exit code is 0 |
| `run(name, args)` | Runs the script `name` of `workflows/` in the package or the project as a child run and returns its result. See [Child runs](#child-runs) |
| `prompts.<name>(inputs)` | The instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section |
| `parallel(thunks)` | Runs the functions at once and returns their results |
| `pipeline(items, ...stages)` | Sends each item through the stages in order, and the items at once |
| `phase(title)`, `log(text)` | Write one step, or one line under the current step, on stderr before the script's next call that runs |

`workflows/script.d.ts` declares these globals for editors. A project gets the same completion when it copies
`script.d.ts` and `jsconfig.json` into `.workflows/workflows/`, and copies them again after an upgrade of the package.

With `schema`, a JSON Schema, the session gets a `respond` tool for that turn. The model gives its answer as
`respond({ answer })`, which ends the turn, and the call returns the checked answer. The schema goes to the model as
JSON in the `answer_schema` system prompt section, and the prompt goes unchanged. A string answer that does not match
the schema is parsed as JSON, and a parsed object or array is checked instead, so an object sent as its JSON text is
accepted. A string answer to a string schema, such as SHIP or FIX, stays a string. An answer that does not match the
schema goes back to the model as an error, and the model tries again. A turn that ends without `respond` gets up to
two reminders to call it, and then the call fails with `the answer did not call respond`. A `respond` answer counts
only for the turn that gave it, and the limit of two reminders holds across an interruption and a resume.

The script runs in the pi-codemode sandbox, with no time limit. It has no file system, network, modules or timers.
Effects go through `sh` and `ok`. `Date`, `Date.now()` and `Math.random()` throw, so that a script makes
the same calls each time it runs.

### Agent profiles

`agents/<name>.md` is the profile of `agent(..., { as: name })`, `session(name)` and `session({ as: name })`. Its
frontmatter gives `model` as `<provider>/<id>` and `thinking`, both optional. Its body, without frontmatter, is the
session's instructions in its system prompt. Every profile gets the same tools as the ship sessions.
`agents/default.md` uses `anthropic/claude-opus-5-5` with thinking `medium`.

A call can give `provider`, `model` and `thinking`. Each field that the call gives overrides the profile, and the
profile fills the rest. A session without a provider or a model from the call or the profile takes the model of the
project agent of harness (Pi's default model), and without a thinking level it takes the project agent's level,
cut to the nearest level that the model has. A model that the host's model registry does not have, or a `thinking`
level that the model does not have, fails the `session` call with harness's error, such as `Unknown model:
anthropic/nope`.

### Saved inputs and resume

Before the run starts, it saves the script, every `workflows/*.js` of the package and the project, the instructions
of every prompt, every profile, the args and the current directory. Resume and `run()` use these saved inputs, so a
later edit of a script, prompt or profile, in the package or in `.workflows/`, changes only new runs.

Resume runs the script again from the top. A call that succeeded before returns its saved result, and is not run
again. A call is known by its name, its arguments and its position among identical calls. A turn that was in progress
continues in its session. A command that was in progress runs again, so commands must be safe to repeat. Each call
records its kind, arguments, phase and start time when it starts, and its end time with its result or its error when
it ends. A call that fails saves no result, so every call that failed runs again, also one that the script caught. The
saved results stay in the project store also after the run fails. `phase` and `log` lines are progress, not saved
results. A resume prints the phase line of the first call that runs, and the lines after it. A call that returns a saved result drops the `log`
lines before it, and keeps the last `phase` line waiting for the next call that runs.

## Resume

```sh
workflows resume <run-id>
```

`workflows resume` finds the workflow that the run saved and continues the run. A run of a workflow script continues
with the script that the run saved. The `project` file of the run directory names the run's project, so resume reaches
the host of that project from any directory.

Resume continues the pending work in the host. For a script, see [Saved inputs and resume](#saved-inputs-and-resume).
For `ship`, it uses the work item, repository, start commit, `workflows/ship.js`, prompts, profiles and round limit
that the run saved before it started. `campaign` does the same with its goal and `workflows/campaign.js`: the split,
the shipped items and the requeues are not run again. It does not read the work item file again, select or clone the
repository again, or create another branch. Answered turns are not sent to the model again. A turn that was in
progress is sent again.

A run has one live task at a time. When the run's last task has not ended, because it runs in the host or waits for
the host to start, resume follows that task: it starts the host when none runs, prints the progress lines that come
after it, and the outcome. A host that starts continues the unfinished runs of its project on its own.

A run that fails with an error prints `failed <subject>: <error>` and `continue with: workflows resume <run-id>`, and
exits 1. Examples are a failing Git hook, or a model error that remains after Pi's retries. The run's task ends as
failed. Resume runs the script again in a new task of the same run, with the same input: a failed Git step runs again,
a failed turn is sent again in the same session, saved calls return their results, and child runs continue. A run whose
task ended in another way, such as a stopped, faulted or orphaned task, resumes in the same way. An ask whose answer
stopped for a reason other than its end, such as its length, fails its call, and a resume asks again. So does an ask
whose answer did not call `respond`. A resumed ask never returns the answer of another ask in its session.

A shipped, blocked or stopped run is final: resume prints the same result and exits with the same code.

A run saved by another version of workflows cannot resume. Resume prints `workflows: run <run-id> was saved by an
earlier version of <workflow> and cannot resume`, or `a later version`, and exits 1. `list` does not show these runs.
The host still starts with such a run in its store: it leaves the run pending and continues the others. Runs saved
before runs moved into the harness host stay in their run directories, and no command reads them.

### Ctrl+C and stop

The run goes on in the host after the command ends. Ctrl+C detaches the command: it prints `detached; run <run-id>
goes on. Follow it with: workflows resume <run-id>. Stop it with: workflows stop <run-id>` and waits 2 s for a second
Ctrl+C. Without one, it exits 130. A second Ctrl+C in those 2 s stops the run: the run's task ends as stopped, and the
command prints `stopped <title>; continue with: workflows resume <run-id>` and exits 130. A third Ctrl+C exits at once.

```sh
workflows stop <run-id>
```

`workflows stop` stops a run that runs, from any directory: it starts the run's host when none runs, aborts the run's
task with its child runs, sessions and Git steps, prints `stopped <title>; continue with: workflows resume <run-id>`
and exits 0. With `--json`, it prints `{ "runId", "status": "stopped" }`. A run whose last task has ended prints
`workflows: run <run-id> is not running` and exits 1. A command that follows a run that `stop` stops prints the
`stopped` line and exits 130. A stopped run resumes in a new task.

Model requests use the retry, stream timeout and compaction settings of Pi's `settings.json` in `~/.pi/agent`, as the
host reads them. The `.pi/settings.json` of the run's directory does not count.

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
- `detached`: Ctrl+C detached the command, and the run goes on in the host.
- `stopped`: a second Ctrl+C or `workflows stop` stopped the run.

The JSON line replaces the `failed`, `continue with`, `detached` and `stopped` lines on stderr, so each stderr line is
a `{"progress":[...]}` line of the run, see [Progress](#progress), or a warning. The exit codes do not change. An error before the run exists, such as
bad usage, prints no `run <run-id>` line and no JSON line.

## List

```sh
workflows list
workflows list --json
```

`workflows list` prints one line for each run of the harness project of the current directory, newest run ID first:
`<run-id> <workflow> <status> <title>`. Runs of other projects are not listed. `<workflow>` is the script name. Child
runs are not listed: they are tasks of their caller. The title is the subject of the first `text`
argument, such as the work item for ship and the goal for campaign, or else the script name. A finished run has the
`status` of its result, such as `shipped`, `blocked` or `stopped` for ship and `done` or `stopped` for campaign, or
`done` when the result has no `status`. Any other run, also a failed one, is `unfinished`. With `--json`, the command prints one JSON array of `{ "runId", "workflow", "title", "status" }`.

`list` reads the project store file and does not start the host, so no run continues. It takes short write locks on
the store: the host waits up to 60 seconds for them, and `list` waits for the host the same way.

## Show

```sh
workflows show <run-id>
workflows show <run-id> --json
```

`workflows show` prints one run as a tree of its phases and calls, from the store of its project:

```text
run <run-id> <workflow> <status> <title>
<phase line>
  ✓ <kind> <label>  <duration>
<report lines, or the failed and continue with lines>
```

- The first line has the fields of `workflows list`, but a run whose task failed has the status `failed`.
- The calls are in the order they started. Each call is under the phase line that was current when it started, and is
  indented by 2. A call before the first `phase` has no phase line above it. The kind is `session`, `ask`, `sh`, `ok`
  or `run`. An `agent` call is a `session` call and an `ask` call.
- The mark is `✓` for a finished call, `✗` for a failed call, and `◉` for a call that started and did not end: it
  runs now, or a stop interrupted it.
- The label is the profile of the session for `session` and `ask`, and the command on one line, cut at 80 characters,
  for `sh` and `ok`. For `run`, it is the workflow name and the child run ID. The phase lines and calls of the child run
  are indented by 2 more under the `run` line.
- The duration is the time of the call, such as `12s`, `3m05s` or `1h02m`. For `◉`, it is the time since the call
  started.
- A finished run ends with its report lines. A failed run ends with `failed <title>: <error>` and `continue with:
  workflows resume <run-id>`. Any other run ends after its calls.

When a call runs again after a resume, `show` shows only its latest attempt. With `--json`, the command prints one JSON
object with the same tree: `{ "runId", "workflow", "title", "status", "report"?, "error"?, "calls" }`. Each call is
`{ "kind", "label", "phase", "args", "mark", "startedAt", "endedAt"?, "result"?, "error"?, "calls"? }`, with ISO
times. `phase` is `null` before the first phase line. The `result` of a `run` call is `{ "runId", "result" }`, with the
result of its child run, and its `calls` are the calls of the child run.

`show` exits 0 for every run it can show. It reads the project store through pi-durable's storage functions, as `list`
does, and does not start the host. It takes short write locks on the store: the host waits up to 60 seconds for them,
and `show` waits for the host the same way. An unknown run ID, or a run directory without a `project` file, prints the
`no run` error of `resume`. A run saved by an earlier version prints `workflows: run
<run-id> was saved by an earlier version of <workflow> and cannot be shown`, and a run saved by a later version prints
`workflows: run <run-id> was saved by a later version of <workflow> and cannot be shown`. These exit 1. Bad usage, such
as no run ID, prints `usage: workflows show <run-id> [--json]` and exits 2.

## Save

```sh
workflows save <run-id> <name> [--force]
```

`workflows save` writes the script of a run to `workflows/<name>.js` of the project folder, and prints the absolute
path of the file. The folder is made when it does not exist. Then `workflows <name>` runs the script, so a script that
started from stdin or from a file can run again by name. The file has the full text of the script that the run saved,
with its `export const meta` header. Only the script is saved: no prompts, agent profiles or scripts of child runs.

- The name is lowercase letters, digits and `-`, and starts with a letter or a digit. Another name, not exactly one
  run ID and one name, or another flag, prints the error, then `usage: workflows save <run-id> <name> [--force]`, and
  exits 2.
- A command name prints `workflows: <name> is a command and cannot be a workflow name` and exits 1.
- An unknown run ID, or the ID of a child run, prints the `no run` error of `resume`. A run saved by an earlier
  version prints `workflows: run <run-id> was saved by an earlier version of <workflow> and cannot be saved`, and a
  run saved by a later version prints the same with `a later version`. These exit 1.
- When a project or package workflow of the name exists, the command prints `workflows: a workflow <name> exists;
  replace it with --force` and exits 1. With `--force`, the file replaces the project script of the name, or adds a
  project script before the package script of the name.

`save` reads the project store as `show` does, and does not start the host. It exits 0 when it wrote the file. `--json`
has no effect.

## Runs in the harness host

A run executes in the [harness](https://github.com/Vzlentin/harness) host of a project, as a task of the `piDurable`
entry of workflows, `src/entry.ts`. harness picks the project from the current directory of the command (or
`HARNESS_PROJECT`): the project with the longest directory that contains it, or `main`. One host runs per project,
with one store, `$XDG_STATE_HOME/harness/<project>/durable.sqlite`, that holds the project agent, its subagents, and
the runs of the project with their saved calls and sessions. The command is a client: it prepares the run (the
arguments, the run ID, the run directory and the worktree), writes the project to the `project` file of the run
directory, starts the host when none runs, asks it to start the run's task, and follows the run. `resume`, `stop`,
`show` and `save` read the `project` file, so they reach the run's project from any directory.

- The host loads workflows and the other `piDurable` packages of Pi's settings when it starts. A host that started with
  another version of workflows runs that version until it restarts. A host of a project inherits the environment of
  the command that starts it, so `sh` and `ok` calls and the sessions' tools see that environment.
- `sh` and `ok` run in the host's process. A host that stops, or crashes, stops its runs, and the host continues them
  when it starts again.
- The sessions of a run are children of the run's task in harness's children library, keyed `wf:<run-id>/<call
  key>`. The task of each resume finds the sessions of the earlier tasks of the run. When the run completes, its task
  closes its sessions and their subagents. When it fails or stops, it closes only what is under its sessions, such as
  their subagents, and stops the turns of its sessions, which stay for a resume.
- Each try of a run is a task that harness starts with the key `wf:<run-id>#<n>`, from 1.

## Pi package

The package is also a Pi package. Its `pi` field in `package.json` declares the extensions `extensions/workflows.ts`
and `extensions/subagent.ts`, and its `piDurable` field declares `src/entry.ts`, which the harness hosts load to run
workflows.
Add it to Pi from its Git URL, like other Pi packages:

```sh
pi install https://github.com/Vzlentin/workflows
```

Update it with:

```sh
pi update --extension https://github.com/Vzlentin/workflows
```

The Pi package needs no build. Pi installs the dependencies, and the extension runs the CLI from its TypeScript
source. Node strips the types, because a git package is not under `node_modules`. The CLI loads harness's client from
`node_modules/harness` through jiti, and starts the host through `node_modules/harness/bin/harness.mjs`. In a checkout, the `workflows`
command still needs `npm run build`, because its `bin` is `dist/cli.js`. See [Setup](#setup).

The install includes [harness](https://github.com/Vzlentin/harness) as a dependency, at a Git ref in `package.json`.
`extensions/subagent.ts` loads harness's extension from `node_modules/harness`, so Pi also gets the `subagent` tool,
the `/subagent` command and the subagents widget. Pi does not start with two tools of one name, so when Pi also loads
the `subagent` extension of a separate package named `harness`, the extension registers nothing and, at session start,
shows:

```text
workflows includes harness. Remove the separate install with: pi remove <source>.
```

The check follows Pi's package scope and resource filters. A project package (`pi remove <source> -l`) always counts,
because a session can trust a project for itself or with `--approve`. In a session that does not trust the project,
the message adds `The subagent tool is off in this session.`

To move from a separate harness install, run `pi remove <source of harness>` and then
`pi update --extension https://github.com/Vzlentin/workflows`, in either order.

### Commands on PATH

After Pi installs or updates the package, its `postinstall` script links two commands into `~/.local/bin`:

- `workflows` to `src/cli.ts` of the install
- `harness` to `node_modules/harness/bin/harness.mjs` of the install

One install owns the links. The script checks each link before it changes any of them:

| The link | Result |
| --- | --- |
| does not exist, or points to a file that does not exist | It is linked |
| points into this install | It is linked again |
| points to a separate Pi install of harness | It is linked |
| points to another workflows install | The script fails and names that install |
| points to a workflows checkout, is a file, or points elsewhere | The script fails. Nothing is overwritten |

The script compares real paths, so a link through other links counts as the install it reaches. Each link is replaced
in one rename, so the command never goes missing. When the script fails on `pi install`, Pi removes its clone and does
not add the package. When it fails on an update, Pi keeps the new code and its dependencies, reports the failure, and
installs the dependencies again at the next update, so the links stay as they were until the conflict is gone.

When Pi's settings have a separate package named `harness`, the script also prints:

```text
workflows: harness is included now. Pi skips its subagent tool from workflows until you run: pi remove <source>
```

The script links nothing in a directory that is neither a Pi git install (under `<agent dir>/git`) nor under
`~/.local/share/workflows` (`XDG_DATA_HOME`), such as a checkout or a project install, unless
`WORKFLOWS_LINK_BINS=1` is set. `WORKFLOWS_BIN_DIR` replaces `~/.local/bin`. `pi remove` does not remove the links.
They then point to nothing, and the next install replaces them.

The extension runs each workflow as a child process of this package's `node src/cli.ts`, in the session's directory,
always with `--json`. So a run that starts in Pi is a normal run of the project of the session's directory, and
`workflows resume` follows or continues it from a terminal. The child process runs outside Pi, so the package has its own copies of `pi-ai` and
`pi-coding-agent` as optional dependencies, which Pi's git install keeps.

### The `workflow` tool

The tool takes one of `name`, `script`, `resume` or `save`, plus `args` with `name` or `script`:

- `name` runs `workflows <name> --<key>=<value>... --json`, with each arg as a flag: a string as it is, `true` as a
  bare `--<key>`, no flag for `false`, and any other value as its JSON text. For example
  `{ name: "ship", args: { item: "Fix the README typo", rounds: 2 } }` runs
  `workflows ship --item=Fix the README typo --rounds=2 --json`. An arg that the script's `meta` does not declare is
  bad usage, so no run starts.
  `{ name: "optimize", args: { workflow: "ship", items: "items/" } }` runs
  `workflows optimize --workflow=ship --items=items/ --json`.
- `script` runs `workflows - --<key>=<value>... --json` with the script on stdin, and each arg as a flag as for `name`.
- `resume` runs `workflows resume <run-id>`.
- `save: { runId, name, force? }` runs `workflows save <run-id> <name>`, with `--force` when `force` is true. See
  [Save](#save).

The tool adds guidelines to the system prompt on how to write a `script`: its shape and `meta`, the script globals,
the sandbox and resume rules, and `save`. A test checks that they name every global of `workflows/script.d.ts`.

Each stderr line of the run is a progress update of the tool. The text of an update is the last line of a
`{"progress":[...]}` line, or the stderr line itself. Esc sends SIGINT to the command, as Ctrl+C does, so the command
detaches after 2 s, and the run goes on in the host. The result then says to follow the run with `resume`, or to stop
it with `workflows stop <run-id>`.

In Pi, the call line is `workflow <name> <slug>`, `workflow <name>`, `workflow script`, `workflow resume <run-id>` or
`workflow save <run-id> <name>`, such as `workflow ship Fix the README typo` or `workflow optimize ship`. The slug comes from the first string arg: the
file name of a `.md` file without `.md`, or else the first 40 characters of its subject. Under it are the lines of the last `{"progress":[...]}` line of the command, as the
command draws them on a terminal, with the marks in the theme's colors, then any other stderr line, such as a warning.
See [Progress](#progress). So a campaign shows its item steps with the ship steps of each item under them. The tool
does not make the steps itself. A finished run ends with its `report` lines,
such as `shipped Fix the README typo in 2 rounds, judge 1.00, 4dfb5c8`. A failed, detached or stopped run ends with
the error or the state, and the run ID to resume. The steps are in the `details` of each update and of the result, so the list draws the
same after a reload. The model gets the same result text as before.

The tool declares an `outputSchema`. Its `structuredContent` is `{ runId, status, result?, report?, error? }`:

- `finished`: the run finished, `result` is its result, such as a `blocked` ship result, and `report` is its report
  lines.
- `failed`: the run failed, and `error` is its error message.
- `detached`: Esc detached the command, and the run goes on in the host.
- `stopped`: `workflows stop` stopped the run.

These are the fields of the JSON outcome line of the command.

A `save` call returns `{ runId, status: "finished", result: { file }, report: [file] }`, with the absolute path of the
file that it wrote. A `save` that fails is a normal tool error with the stderr text.

A failed, detached or stopped result is an error result that keeps `structuredContent`. Thus
`await tools.workflow({ name: "ship", args: { item } })` in a codemode script gets this object. A call that fails
before a run exists, such as an unknown workflow name, is a normal tool error with the stderr text.

## Run directory

Runs live in `$XDG_STATE_HOME/workflows/runs/<run-id>`, by default `~/.local/state/workflows/runs/<run-id>`:

- `project`: the name of the harness project whose store holds the run: its saved inputs, calls, sessions and progress

The project store is `$XDG_STATE_HOME/harness/<project>/durable.sqlite`. See [Runs in the harness
host](#runs-in-the-harness-host).

A ship run also has:

- `worktree/`: the worktree on `ship/<run-id>`
- `repository/`: the clone, for a GitHub repository only
- `round-<n>.patch`, `round-<n>-fix.patch`: the patches each review got

A campaign run has `worktree/` on `campaign/<run-id>` and `repository/` in the same way, plus:

- `item-<n>/`: the `round-<n>.patch` and `round-<n>-fix.patch` files of item `n`

An optimize run has:

- `baseline/<name>.md` and `best/<name>.md`: the baseline texts and the texts of the best candidate
- `prompts.diff`: the score lines and the diff

A child run that `run()` starts is a run directory of its own, next to the caller's, without a `project` file: it is a
task of the caller's run. A child run without a worktree can have an empty run directory.

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
`workflows` command for the extension, and temporary Git repositories. Each command of a test runs a harness host in
the test process, with Pi's settings listing this checkout, and the host closes when the command ends. They do not
call a real model or open Pi.

The engine files in `src/`:

- `cli.ts`: the `workflows` command entry point.
- `main.ts`: the commands `start`, `resume`, `stop`, `list`, `show` and `save`, a client of the harness host, and the
  run directory.
- `entry.ts`: the `piDurable` entry that the harness host loads, with the script task.
- `progress.ts`: the tree of steps of a run, and how the command draws it on stderr.
- `meta.ts`: the `meta` of a workflow script, its arguments, its usage, `check`, and the report lines and exit code of
  a run.
- `task.ts`: the task of every script run, its saved input and checkpoint, its phase, child runs, and the end of its
  sessions.
- `script.ts`: the workflow script calls, agent profiles, prompts for scripts, and sessions on harness's children
  library.
- `run.ts`: the run ID, usage errors, and what a run gets from the command line.
- `harness.ts`: the check for a separate harness package in Pi, for `extensions/subagent.ts`.
- `git.ts`: Git commands, repository selection and worktrees.
- `prompts.ts`: the instructions of a prompt template.
