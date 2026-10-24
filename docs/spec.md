# workflows reference

The behaviour of the `workflows` command, the workflow scripts, runs and the `workflow` tool. The
[README](../README.md) has the install.

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
research session:   research (documents the code as it is)
plan session:       plan (with the research)  ->  challenge  ->  handoff
implement session:  implement the handoff                      <- round n (at most --rounds)
review session:     review  ->  challenge (SHIP or FIX)  ->  handoff (on FIX, back to implement)
judge session:      fixed rubric, then commit message and branch, after SHIP
```

Each box is a new session.

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
defaults to 3. `--branch <name>` gives the name of the branch that a shipped run ends on.

`--prompts <folder>`, relative to the current directory, gives prompts for this run: each `<name>.md` in the folder
replaces the package prompt `prompts/<name>.md`, in the same template format. A missing folder, or a file with no
package prompt of that name, fails before the run starts. The run saves the prompts that it used, as any run does.
`campaign` and `optimize` take the same option.

Without `--repo`, the run uses the Git repository that contains the current directory. With `--repo`, the value is
first a path, relative to the current directory. If that path is the top level of a local Git repository, the run
uses it and its local `--base` commit. Otherwise `gh repo clone <value>` clones the repository into the run
directory, and the run starts from the cloned `origin/<base>`. A bare name such as `calibre` clones from the
authenticated user, and `owner/calibre` names the owner.

The command prints `run <run-id>`, then one progress step on stderr as each session starts: `research`, `plan`,
`round <n>: implement`, `round <n>: review` and `judge`. See [Progress](#progress) for how the steps show. A resume
prints the phase line of the first call that runs, such as a turn or a Git step, and the lines after it.

The research session gets the work item and writes a research document: what the code that the work item touches
does today, with `path:line` references, the patterns and tests of that area, and open questions. It documents and
does not suggest changes, and if it has a subagent tool, can spawn subagents to search in parallel. The plan prompt
gets its reply as its `research` section, after the work item. The research prompt has no memory and gives no notes.

The work item ships onto the branch `ship/<run-id>`, in a worktree in the run directory, and a shipped run renames that
branch at the end. The selected repository's checkout, index and local edits stay unchanged. Ship does not push and does
not open a pull request.

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

On SHIP, the judge session reviews the change in the worktree. The judge answers through `respond`: eight PASS or
FAIL answers, and one finding line for each failed question. If question 1 (complete) or 2 (correct) fails, the score
is 0. Otherwise the score is the fraction of questions 3 to 8 that pass. If the judge fails or does not answer through
`respond`, the command prints `judge failed on <subject>: <error>` on stderr.

When the judge answered, the same judge session then gets the `commit` prompt, and answers through `respond` with
`branch`, `subject` and `body`: a commit message that follows the commit rules of the repository, and a short branch
name. The run squashes the work into one commit with the message `<subject>`, an empty line, then `<body>`:

```text
fix: correct the README typo

The README said wrold. It now says world.
```

If the judge failed, or the message turn fails or answers an empty `subject`, the message is the subject of the work
item alone: its first non-empty line without leading `#`. A failed message turn prints nothing and does not change the
score.

After the squash, the run renames `ship/<run-id>` to the `--branch` name, or else to the judge's `branch`. It renames
only when the worktree is on `ship/<run-id>`, so a repeat of the step after the rename keeps the branch it renamed to.
When the name exists, the run adds `-2`, `-3` and so on, until the name is free. No name, an empty judge `branch` or a
judge answer that was not used keeps `ship/<run-id>`. A name that Git rejects, because it is not a valid branch name or
it is in conflict with an existing branch, such as `docs/typo` when `docs` exists, keeps `ship/<run-id>`, and the
command prints a second report line with the reason: `branch <name> is not a valid branch name; kept ship/<run-id>`
or `branch <name> is in conflict with an existing branch; kept ship/<run-id>`. The command prints `shipped
<subject> in <n> rounds, judge <score or failed>, <commit> on <branch>` and exits 0.

The result of the run, which `--json` prints, has `status` and `rounds`; `head` and `branch`, the branch that the
worktree ends on, when shipped; `score`, `answers`, the eight answers in question order, and `findings`, the finding
lines of the judge, when the judge answered; `judgeError` when the judge failed; `reply` when blocked; and `memory`, the
memory lines in order or `[]` when there are no notes, for every status.

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
work item ships in turn, in one worktree on the branch `campaign/<run-id>`: the research, the plan, the rounds, the
review, the judge and the squash of `workflows/ship.js`, from the commit that the item before it made. So each shipped
item is one commit, with the commit message that its own judge wrote, as in `ship`. No `ship/<run-id>` branch is made,
and nothing is merged or pushed. Each item is a ship child run, with its own
run ID and run directory, in the store of the campaign run: see `run` in [the script API](#the-script-api).

After each shipped item, also the last one, a new planner session gets the goal, the shipped item and the remaining
items with the `requeue` prompt. Its answer through `respond` is the new queue, which can be empty. The campaign ends
when the queue is empty. The queue has no length limit: a requeue can add items each time.

The command prints `run <run-id>`, then the step `item <n>/<total>: <subject>` on stderr before the steps of each item.
`<total>` is the number of items known when the item starts: the shipped items, this item and the queue. A requeue can
change it. The steps of the item's ship run are under the item step, indented by 2:

```text
✓ item 1/2: Fix the README typo
  ✓ research
  ✓ plan
  ✓ round 1: implement
  ✓ round 1: review
  ✓ judge
◉ item 2/2: Add a thanks line
  ✓ research
  ◉ plan
```

See [Progress](#progress). At resume, the first steps of the item it continues can come before the item step. On a
terminal and in Pi they move under the item step when it comes.

When the queue is empty, a new planner session gets the goal and the subjects of the shipped commits, in order, with
the `branch` prompt, and answers the branch name through `respond`. This turn prints no step. The run renames
`campaign/<run-id>` to that name, as `ship` renames `ship/<run-id>`: only when the worktree is on `campaign/<run-id>`, so
a repeat of the step after the rename keeps the branch it renamed to, and with `-2`, `-3` and so on when the name
exists. A failed turn or an empty name keeps `campaign/<run-id>`. A name that Git rejects, because it is not a valid
branch name or it is in conflict with an existing branch, keeps `campaign/<run-id>`, and the command prints a second
report line with the reason: `branch <name> is not a valid branch name; kept campaign/<run-id>` or `branch <name> is in
conflict with an existing branch; kept campaign/<run-id>`.

- When the queue is empty, the command prints `done <subject> in <n> items, <commit> on <branch>` with the commit of the
  last item and the branch that the worktree ends on, and exits 0.
- When an item is blocked or stopped, or ships with a judge score of 0, the campaign stops. The command prints
  `stopped <subject> at item <n>: <worktree>` and exits 1. A missing score, when the judge failed, does not stop it.

`<subject>` is the first non-empty line of the goal without leading `#`. The result is
`{ "status": "done", "head", "branch", "items": [{ "item", "result" }] }` or `{ "status": "stopped", "items" }`, with
the `ship` result of each item that ran, and its child run ID as `result.runId`. `head` is the commit of the last item,
and `branch` is the branch that the worktree ends on.

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

`--improve` lists the prompts to optimize, separated by commas: any of `research`, `plan`, `challenge`, `handoff`,
`implement` and `review`. The default is `review,challenge,handoff`. `judge` gives the score, so it is never a
candidate. `--trials` is the number of candidates that the run evaluates, the baseline included, and defaults to 3. A
workflow other than `ship`, an unknown prompt name, fewer than 2 items, or an item without `repo` or `start` fails the
run after `run <run-id>`, with `failed optimize: <error>`, and exits 1, because the script checks them when it runs.

A candidate is one text for each listed prompt. The baseline is the texts of the run's prompts, so `--prompts
<folder>` sets it. Each evaluation is the child run
`run("ship", { item, repo, base: start, prompts: candidate })`, one at a time. The score of a shipped run is
`passes/8 - 0.1*(rounds-1)`, where `passes` is the number of PASS answers of the judge, or 0 when the judge failed. A
blocked or stopped run scores 0. After a ship run finishes, its worktree and its branch are removed: the `branch` of its
result, or `ship/<run-id>` when it did not ship. Its run directory stays. There is no evaluation cache: a reflect text
equal to an earlier candidate's text ships again.

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

The research, plan, implement, review and judge sessions use the agent profiles `agents/researcher.md`,
`agents/planner.md`, `agents/implementer.md`, `agents/reviewer.md` and `agents/judge.md`. Each uses
`anthropic/claude-opus-5-5` with thinking `medium`, and every session gets the same tools. Like every workflow script,
`ship` and `campaign` read the scripts, prompts and profiles of the package and of the project folder `.workflows/` of
the current directory, also when `--repo` selects another repository. See [Workflow scripts](#workflow-scripts). A
project `agents/planner.md`, for example, gives the planner another model.

Sessions are children of harness's children library in the harness host of the run's project, and use the host's
providers and credentials: Pi's, from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), including the providers that Pi
extension packages register, such as `cursor`. Their system prompt has the `AGENTS.md` instructions and skills that Pi
loads for the worktree, as harness gives its children: project skills only in a project that Pi trusts.

The tools are `read`, `grep`, `find`, `ls`, `write`, `edit` and `bash`, harness's `subagent` and `codemode` tools, and the tools of
the packages in Pi's settings that declare `"piDurable": { "extensions": [...] }`, such as pi-ipython and pi-rlm. The
host loads these packages once, when it starts, so a package installed later reaches the runs of a project after its
host restarts. A subagent that a session spawns is a child of that session.

A session of a run that a command starts is at depth 1 of harness's tree of children, in the tree
`workflows:<root-run-id>`, and its subagents at depth 2, the deepest that harness allows. A run that the `workflow`
tool of a conversation of the host starts puts its sessions under that conversation instead, see
[The `workflow` tool of the host](#the-workflow-tool-of-the-host).

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

`resume`, `stop`, `list`, `show`, `save`, `prune` and `check` are commands, so no script of these names can run. Bad
usage of a command prints `workflows: <error>`, then `usage:` and the usage line of that command, such as `usage:
workflows show <run-id> [--json]`, and exits 2.

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

Every script also takes `--prompts <folder>`, as `ship` does, `--background`, `--json` and `--help`. `workflows <wf> --help` prints
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
literal, or an object with a spread, is checked when the session opens. A regular expression literal is skipped, so a
quote in it hides no later field. `check` also checks the `model:` line of each agent profile that the script uses,
by name or as `default` for a `session` or `agent` call, and fails with `<name> uses the agent profile <profile>, whose
model <provider>/<id> Pi's model registry does not have`. `check` prints `ok <name>` and exits 0, or prints the first
problem and exits 1. It starts no run and writes nothing.

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
  With `meta.worktree`, a `start` that is not a string fails the call with `run <name>: start is not a string`.
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

A call with an argument of the wrong type, such as a prompt that is not a string, a `sh` command that is not a string
or an array of strings, or a `prompts.<name>` input that is not a string, fails with
`<call> got bad arguments: <path> <problem>`, where `<call>` is `session`, `ask`, `sh`, `ok`, `run` or `prompt`, and
`<path>` points to the deepest wrong value in the arguments, such as `/0/1` for `sh(["git", 1])`.

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

When the script ends, by its result or by an error, the calls that it did not wait for are cancelled: a `sh` or `ok`
command is killed, a `run()` call stops waiting for its child run, and an ask stops waiting for its turn. The script's
task ends only once they stopped, so no call goes on after the run ended. A cancelled call records no end, and runs
again on resume.

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

With `--background`, at any position before `--`, start and resume print `run <run-id>` once the host has the run's
task, and exit 0 without following it. With `--json`, they also print `{"runId":"<run-id>","status":"started"}`. A
Ctrl+C after the host accepted the task does not change this. The other commands ignore `--background`. Follow such a
run with `workflows wait <run-id>` or `workflows resume <run-id>`. A start with `--background` saves `notify` in the
input of the run. A resume that starts a new task saves `notify` only with `--background`, whatever the last task
had. A resume that follows a task that has not ended does not change it. See
[The `workflow` tool of the host](#the-workflow-tool-of-the-host) for what `notify` does.

A run has one live task at a time. When the run's last task has not ended, because it runs in the host or waits for
the host to start, resume follows that task and prints its outcome. When the host runs, resume prints the progress
lines of the task's current execution from its start. When no host runs, resume starts it and prints the progress
lines that come after. A host that starts continues the unfinished runs of its project on its own. When resume starts
a new task, it prints the progress lines of that task.

A run that fails with an error prints `failed <subject>: <error>` and `continue with: workflows resume <run-id>`, and
exits 1. Examples are a failing Git hook, or a model error that remains after Pi's retries. The run's task ends as
failed. Resume runs the script again in a new task of the same run, with the same input: a failed Git step runs again,
a failed turn is sent again in the same session, saved calls return their results, and child runs continue. A run whose
task ended in another way, such as a stopped, faulted or orphaned task, resumes in the same way. An ask whose answer
stopped for a reason other than its end, such as its length, fails its call, and a resume asks again. So does an ask
whose answer did not call `respond`. A resumed ask never returns the answer of another ask in its session.

A shipped, blocked or stopped run is final: resume prints the same result and exits with the same code.

A run saved by another version of workflows cannot resume. Resume prints `workflows: run <run-id> was saved by an
earlier version of <workflow> and cannot resume`, or `a later version`, and exits 1. `list` shows these runs as
`earlier-version` or `later-version` while their task has not ended. The host still starts with such a run in its
store: it leaves the run pending, prints a `warning:` line in its log for an earlier version, and continues the others.
Such a run does not keep the host from exiting when it is idle. `workflows stop` ends it as `orphaned`.

Runs saved before runs moved into the harness host stay in their run directories, and no command reads them.

A host keeps the version of workflows that it loaded when it started. Each `start` request, of a new run or of a
resume, gives the version of the workflows task, and a host with another version refuses it before it creates
anything. The command then prints `workflows: This host has version <n> of workflows.run, not <m>: stop the host so
it starts again with the installed version (the harness host of project <project> has pid <pid>: kill <pid>)` and
exits 1. A new run then has no run directory; a resumed run keeps its tasks as they were. When a command follows a task
that it did not start, it checks the version of that task in the same way.

When the `start` request fails in another way, such as a connection that closes, the command asks the host for the
task. When the host has it, the run started, and the command checks its version and follows it. When the command
cannot tell, it keeps the run directory and prints the error with `run <run-id> may have started: workflows resume
<run-id>`.

### Ctrl+C and stop

The run goes on in the host after the command ends. Ctrl+C detaches the command: it prints `detached; run <run-id>
goes on. Follow it with: workflows resume <run-id>. Stop it with: workflows stop <run-id>` and waits 2 s for a second
Ctrl+C. Without one, it exits 130, or reports the outcome of a run that ends in those 2 s. A second Ctrl+C in those
2 s stops the run: the run's task ends as stopped, and the command prints `stopped <title>; continue with: workflows
resume <run-id>` and exits 130. A second Ctrl+C that comes before the command waits for it, such as one right after
the first, stops the run in the same way. A second Ctrl+C while the command follows no run, and a third, exit at once.
A Ctrl+C before the run starts, such as while the command clones the repository, starts no run: the command removes
the run directory, prints `workflows: interrupted before the run started` and exits 130.

When the host stops while the command follows the run, the run stays pending: the command prints `the host stopped;
the run continues when it starts again: workflows resume <run-id>`, leaves the steps as they are and exits 1. The next
host continues the run when it starts, and `resume` starts it.

```sh
workflows stop <run-id>
```

`workflows stop` stops a run that runs, from any directory: it aborts the run's task with its child runs, sessions and
Git steps, prints `stopped <title>; continue with: workflows resume <run-id>` and exits 0. When no host runs, `stop`
starts the run's host, and the host resumes the run before the abort reaches it: a `sh` or `ok` command that a host
stop cut runs again from its start, and an ask that was in progress continues its turn, until the abort stops them. With `--json`, it prints `{ "runId",
"status": "stopped" }`. A run whose last task has ended prints `workflows: run <run-id> is not running` and exits 1.
`stop` also stops a pending run of another version of workflows, which no host can run: its task ends as `orphaned`,
and the command prints `stopped <workflow>, which an earlier version saved; it cannot resume` (or `a later version`). A command that follows a run that `stop` stops prints the
`stopped` line and exits 130. A stopped run resumes in a new task.

Model requests use the retry, stream timeout and compaction settings of Pi's `settings.json` in `~/.pi/agent`, as the
host reads them. The `.pi/settings.json` of the run's directory does not count.

## Wait

```sh
workflows wait <run-id> [--json]
```

`workflows wait` follows a run to its outcome, and never starts a task or stops the run. It prints `run <run-id>`, then
the same outcome lines, JSON line and exit code as `resume`. A run whose task ended, completed or not, prints its
outcome from the project store: `wait` starts no host and no task, so a failed run prints its `failed` and `continue
with` lines and exits 1. A run whose task has not ended is followed as `resume` follows it, and `wait` starts the host
when none runs. `wait` checks the version of the host's task as `resume` does, and refuses a run that another version
saved with `workflows: run <run-id> was saved by an earlier version of <workflow> and cannot be waited for`.

Ctrl+C detaches `wait` at once: it prints the `detached` line, or the `detached` JSON line, and exits 130. The run goes
on in the host. A second Ctrl+C exits and never stops the run. Bad usage prints `usage: workflows wait <run-id>
[--json]` and exits 2.

## JSON output

```sh
workflows ship --json plan.md
workflows resume <run-id> --json
workflows wait <run-id> --json
```

Every form of start, resume and wait accepts `--json`, at any position before `--`. After `run <run-id>`, stdout gets one
line of JSON in place of the report lines, `{ "runId", "status", "result"?, "report"?, "error"? }`, for every outcome:

- `finished`: `result` is the result of the run, for example `{"status":"shipped","rounds":1,"head":"1a2b3c4",...}`
  for ship. The [Ship](#ship) section lists the fields of a ship result. `report` is the list of report lines that
  the command prints without `--json`, such as `["shipped Fix the README typo in 1 rounds, judge 1.00, 1a2b3c4 on fix/readme-typo"]`.
- `failed`: `error` is the error message.
- `started`: with `--background`, the host has the run's task, and the command does not follow it. The `workflow`
  tool of the host and the `workflow` tool of Pi give it as a result that is not an error.
- `detached`: Ctrl+C detached the command, and the run goes on in the host.
- `stopped`: a second Ctrl+C or `workflows stop` stopped the run.
- `host-stopped`: the host stopped while the command followed the run, which stays pending.

The JSON line replaces the `failed`, `continue with`, `detached`, `stopped` and `host stopped` lines on stderr, so each stderr line is
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
`done` when the result has no `status`. A run whose task has not ended is `running`, also when it waits for its host
to start. A run whose task ended without a result is `stopped`, `failed`, `faulted` or `orphaned`. A pending run that
another version of workflows saved is `earlier-version` or `later-version`, with its workflow name as its title: it
cannot resume. With `--json`, the command prints one JSON array of `{ "runId", "workflow", "title", "status" }`.
Only the runs that have a run directory with a `project` file are listed.

`list` reads the project store file read-only and does not start the host, so no run continues. It takes no lock that
the host waits for, and runs no checkpoint of the file. A store whose schema pi-durable must update first cannot open
read-only: `list`, `show` and `save` then fail with `<store> needs a schema update that only its harness host makes:
start the host once, such as with harness --project <project> host, and run the command again`.

## Prune

```sh
workflows prune [--yes] [--install-hook] [--json]
```

`workflows prune` prints one line `<run-id> <branch> <worktree>` for each run of the harness project of the current
directory, newest run ID first, whose worktree is on a branch with a merged pull request. With `--json`, it prints one
JSON array of `{ "runId", "branch", "worktree" }`. A run is a candidate only when it has a run directory with a
`project` file, its last task has ended, a task of this version saved it, its worktree exists, and the worktree is on a
branch. A run that has not ended, a run of another version, a detached worktree, and a worktree that is not a Git
worktree of its own are never pruned. `prune` reads the project store file read-only, as `list` does, and does not
start the host.

For each candidate, `prune` runs `gh pr list --head <branch> --state merged --json headRefOid` in the worktree. A branch
is merged when one pull request in the list has the commit that the worktree is on as its head. A branch name that comes
back in a later run, with a merged pull request of an earlier commit, is not merged. `prune` runs every `gh` call before
it removes anything: a failed `gh` call, or a missing `gh`, prints `workflows: <error>`, removes nothing and exits 1.

With `--yes`, `prune` removes each merged worktree in order, and prints its line after the removal. When `HERDR_ENV` is
set and `herdr worktree list --cwd <worktree>` shows a workspace open on the worktree, it runs `herdr worktree remove
--workspace <id>`. Otherwise, or when a herdr command fails, it runs `git worktree remove <worktree>` in the run's
repository, without `--force`. Then it deletes the branch with `git branch -D <branch>` when the branch still exists. A
removal that fails, such as of a worktree with changes, prints the error and exits 1; the next `prune` tries again. The
run directory and the run's records stay, so `list` and `show` still show the run.

`--install-hook` writes the executable `post-merge` hook of the Git repository of the current directory, with the line
`workflows prune --yes >/dev/null 2>&1 &`, and prints the hook's path. When `core.hooksPath` is set or a `post-merge`
hook exists, it writes nothing, prints an error with the line to add, and exits 1. `--install-hook` ignores `--yes` and
`--json`.

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

- The first line has the fields of `workflows list`.
- The calls are in the order they started. Each call is under the phase line that was current when it started, and is
  indented by 2. A call before the first `phase` has no phase line above it. The kind is `session`, `ask`, `sh`, `ok`
  or `run`. An `agent` call is a `session` call and an `ask` call.
- The mark is `✓` for a finished call and `✗` for a failed call. A call that started and did not end is `◉` while the
  run's task has not ended: it runs now, or the host stopped. Once the task ended, such a call is `✗`, without a
  duration: the end of the task cut it.
- The label is the profile of the session for `session` and `ask`, and the command on one line, cut at 80 characters,
  for `sh` and `ok`. For `run`, it is the workflow name and the child run ID. The phase lines and calls of the child run
  are indented by 2 more under the `run` line.
- The duration is the time of the call, such as `12s`, `3m05s` or `1h02m`. For `◉`, it is the time since the call
  started.
- A finished run ends with its report lines. A failed run ends with `failed <title>: <error>` and `continue with:
  workflows resume <run-id>`, a stopped run with `stopped <title>; continue with: workflows resume <run-id>`, and an
  orphaned run with `orphaned <title>: <reason>` and the `continue with` line. Any other run ends after its calls.

When a call runs again after a resume, `show` shows only its latest attempt. With `--json`, the command prints one JSON
object with the same tree: `{ "runId", "workflow", "title", "status", "report"?, "error"?, "calls" }`. Each call is
`{ "kind", "label", "phase", "args", "mark", "startedAt", "endedAt"?, "result"?, "error"?, "calls"? }`, with ISO
times. `phase` is `null` before the first phase line. The `result` of a `run` call is `{ "runId", "result" }`, with the
result of its child run, and its `calls` are the calls of the child run.

`show` exits 0 for every run it can show. It reads the project store through pi-durable's storage functions, as `list`
does, and does not start the host. It reads the file read-only as `list` does. An unknown run ID, or a run directory
without a `project` file, prints the
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

## Install

workflows has no copy of harness. `@vzlentin/harness` is an optional peer dependency of `@vzlentin/workflows`, in the
caret range of its `package.json`. A global install of workflows uses the global install of harness next to it, so the
`workflows` command, the harness host and the `harness` command all load the same harness.

### Setup

The setup acts only on a top-level global install: the package folder, with symbolic links resolved, is
`<prefix>/lib/node_modules/@vzlentin/workflows` (`<prefix>/node_modules/...` on Windows), with no other
`node_modules` above. npm also sets `npm_config_global` for the dependencies of a global package, so the path decides.
Two places run it:

- The postinstall, `scripts/postinstall.js`, when npm runs install scripts (npm 11; npm 12 does not by default) and
  `npm_config_global` is `true`. It never fails the install: when npm installs a new package and its postinstall
  fails, npm removes the package and keeps its `bin` link, which then points to nothing.
- The installed command (`dist/cli.js`), on each start, before it loads `main.ts`. The Pi steps run through
  `setupOnce` of `@vzlentin/harness/setup`, which keeps a stamp for each package path and version and writes it only
  when its `pi` commands worked (see harness's spec). So once the setup is done, a start only checks harness, the
  stamps and the entry, and after a failed `pi` command the next start tries again. A checkout (`node src/cli.ts`)
  runs no setup.

The steps:

1. When harness is missing or older than the range, it prints `workflows: installing @vzlentin/harness: npm install -g
   --prefix <prefix> @vzlentin/harness@<range>` and runs that command, with the npm of the install in an install
   script, or the `npm` on `PATH`. It prints the output of npm on stderr only when npm fails. When harness still does
   not fit, it prints the error line below, and stops.
2. It runs harness's setup (`setupOnce` of `@vzlentin/harness/setup`) for the global harness, which registers
   harness's Pi extension, also when npm ran no install script of harness.
3. It sets the entry `workflows` in harness's `entries.json` to `dist/entry.js` of the install. So a host that starts
   before any `workflows` command, such as one that `harness` or Pi starts, runs workflows. The path has no version,
   so it stays the same across updates.
4. With harness's `setupOnce` for the workflows package: it runs `pi install <install>/pi`. `pi` is looked up on
   `PATH` without the folders that end in `node_modules/.bin`, as a dependency has a `pi` of its own. A Pi failure
   prints `workflows: pi install failed (<reason>). To add the Pi extension of workflows, run: pi install
   <install>/pi`. Pi records the real path of `<install>/pi`.

A failure of the setup prints `workflows: setup failed: <message>`, or `harness: setup failed: <message>` when it
comes from harness's `setupOnce`, and the command goes on.

### The harness check

Every `workflows` command checks harness before it loads any harness module. When harness is missing or older than
the range, an installed command runs step 1 of the setup and goes on when harness then fits. A harness newer than the
range, also a prerelease such as `0.3.0-rc.1` for `^0.2.0`, is never replaced. Otherwise it prints one of
these lines and exits 1:

- `workflows needs @vzlentin/harness <range>: npm install -g [--prefix <prefix>] @vzlentin/harness@<range>`
- `workflows needs @vzlentin/harness <range>, found <version>: npm install -g [--prefix <prefix>]
  @vzlentin/harness@<range>`
- `workflows needs @vzlentin/harness <range>, found <version>, which is newer. Update workflows: npm install -g
  [--prefix <prefix>] @vzlentin/workflows`

`--prefix <prefix>` is there when the install is a top-level global install whose prefix is not the output of `npm
prefix -g`. In an install script, npm sets `npm_config_prefix` to the `--prefix` of the install, so the setup runs
`npm prefix -g` without it.

## Runs in the harness host

A run executes in the [harness](https://github.com/Vzlentin/harness) host of a project, as a task of the entry of
workflows, `src/entry.ts`. harness picks the project from the current directory of the command (or
`HARNESS_PROJECT`): the project with the longest directory that contains it, or `main`. One host runs per project,
with one store, `$XDG_STATE_HOME/harness/<project>/durable.sqlite`, that holds the project agent, its subagents, and
the runs of the project with their saved calls and sessions. The command is a client: it prepares the run (the
arguments, the run ID, the run directory and the worktree), writes the project to the `project` file of the run
directory, starts the host when none runs, asks it to start the run's task, and follows the run. `resume`, `stop`,
`show` and `save` read the `project` file, so they reach the run's project from any directory.

- The host loads its entries when it starts: the `piDurable` entries of the packages in Pi's settings, and the entries
  of harness's `entries.json`. Each command that can start a host sets the entry `workflows` there to `dist/entry.js`
  of its install, or `src/entry.ts` of a checkout. The setup of a global install sets it too, see
  [Setup](#setup). A host that started with another version of workflows runs that
  version until it restarts. A host that started before the entry was set refuses a start with
  `workflows: Unknown task kind: workflows.run: the harness host started before it had the entry of workflows; stop it
  so it starts again with the entry (the harness host of project <project> has pid <pid>: kill <pid>)`, and no run
  directory stays. A host of a project inherits the environment of
  the command that starts it, so `sh` and `ok` calls and the sessions' tools see that environment.
- `sh` and `ok` run in the host's process. A host that stops, or crashes, stops its runs, and the host continues them
  when it starts again.
- The sessions of a run are children of the run's task in harness's children library, keyed `wf:<run-id>/<call
  key>`. The task of each resume finds the sessions of the earlier tasks of the run. When the run completes, its task
  closes its sessions and their subagents. When it fails or stops, it closes only what is under its sessions, such as
  their subagents, and stops the turns of its sessions, which stay for a resume.
- Each try of a run is a task that harness starts with the key `wf:<run-id>#<n>`, from 1.

### The `workflow` tool of the host

The entry also gives the conversations of the host the `workflow` tool: the project agent, its subagents, and the
subagents of sessions. The sessions of a run do not get it. It takes the parameters of
[The `workflow` tool](#the-workflow-tool) of Pi, and runs the `workflows` command of the same install as a child
process with the Node of the host, in the conversation's directory, with `--json`. It sets `HARNESS_PROJECT` to the
project of the host and `PI_SESSION_ID` to the conversation ID.

- When the command prints `run <run-id>`, the running output of the call gets `run <run-id>: if this call stops, the
  run is detached and goes on in the harness host; follow it with resume: "<run-id>"`. Each stderr line appends a line to the running output, the last progress line or the line itself,
  and sets the `details` of the call to `{ steps }`, the progress lines of the command then any other stderr line.
  The result keeps the last `details`.
- The result text of a finished run is the summary of Pi's tool, then the `report` lines. A failed, detached, stopped
  or host-stopped run is an error result with its summary, and keeps the structured output
  `{ runId, status, result?, report?, error? }`.
- `background: true`, with `name`, `script` or `resume`, adds `--background` to the command. With `save`, it is an
  error and no command starts. The result is `started`, which is not an error: `run <run-id> started in the
  background; its result comes as a message in this conversation when it ends; follow it with resume: "<run-id>", or
  stop it with the command workflows stop <run-id>`.
- A task whose input has `notify` posts its outcome to the conversation `parent` when it ends, after it ends its
  sessions and before its end commits. The post is a follow-up input of the entry kind `workflows.result`, with the
  data `{ runId, status }` and the text of the tool result for that outcome: `finished` with the report lines,
  `failed` with the error, or `stopped`. Its request ID is `workflows.result:<run-id>/<task-id>`, so a rerun of the
  phase posts once, and each later task of the run posts again. A child run never has `notify`. Nothing is posted
  when `parent` is not a conversation ID of the host, such as the session ID of Pi, or when the host stops: the task
  stays pending and posts when it ends after the restart. A failed post goes to the host's report and does not
  change the outcome of the run. A `background` resume of a task that has not ended, such as a run that a call
  without `background` started, posts nothing.
- Esc in a conversation aborts the call: the command gets SIGINT, detaches, and the run goes on in the host. The
  result is an error that keeps the running output, so it names the run, says that it is detached, and says to follow
  it with `resume`. A call
  that a host restart interrupts does not run again; its error result also keeps the running output.
- The command saves `PI_SESSION_ID` in the input of the run as `parent`, and the child runs get the same `parent`.
  When it is the project agent or a conversation of the children library, the sessions of the run are children of
  that conversation: under the project agent at depth 1, under a subagent at depth 2. Else, such as for the session ID
  of Pi, they are in the tree `workflows:<root-run-id>`. A session of a run under a subagent is in the subagent's
  list of children, so closing that subagent closes the session.
- A conversation at the depth limit of its tree, such as a subagent of a session, gets the error `a subagent at depth
  <depth> cannot use workflow: the sessions of a run would be deeper than the depth limit <limit>`, and no command
  starts.

## Pi

The `pi/` folder of the package is the Pi extension that gives Pi the `workflow` tool. The setup of a global
install registers it, see [Setup](#setup). It runs each workflow as a child process of the `workflows` command of
the same install (`../dist/cli.js` from the extension), with the Node that runs Pi, in the session's directory, always
with `--json`. With `background`, the call returns at once, and the extension posts the outcome of the run to the
session as a message, see [Background runs in Pi](#background-runs-in-pi). So a run that starts in Pi is a normal run of the project of the session's directory, and `workflows resume`
follows or continues it from a terminal.

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
- `background: true`, with `name`, `script` or `resume`, adds `--background` before `--json`. With `save`, it is the
  error `background works only with name, script or resume`, and no command starts.

The tool adds guidelines to the system prompt on how to write a `script`: its shape and `meta`, the script globals,
the sandbox and resume rules, `save`, and `background`. A test checks that they name every global of
`workflows/script.d.ts`.

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
such as `shipped Fix the README typo in 2 rounds, judge 1.00, 4dfb5c8 on fix/readme-typo`. A failed, detached or stopped run ends with
the error or the state, and the run ID to resume. The steps are in the `details` of each update and of the result, so the list draws the
same after a reload. The model gets the same result text as before.

The tool declares an `outputSchema`. Its `structuredContent` is `{ runId, status, result?, report?, error? }`:

- `finished`: the run finished, `result` is its result, such as a `blocked` ship result, and `report` is its report
  lines.
- `failed`: the run failed, and `error` is its error message.
- `started`: a `background` call started the run, or a new task of it, and does not follow it. It is not an error,
  its text is `run <run-id> started in the background; its result comes as a message in this conversation when it
  ends; follow it with resume: "<run-id>", or stop it with the command workflows stop <run-id>`, and it draws
  `◉ started in the background`.
- `detached`: Esc detached the command, and the run goes on in the host.
- `stopped`: `workflows stop` stopped the run.
- `host-stopped`: the host stopped while the command followed the run, which continues when the host starts again.

These are the fields of the JSON outcome line of the command.

### Background runs in Pi

After a `started` result, the extension appends the session entry `workflow-background` with the data
`{ runId, cwd }`, and follows the run with `workflows wait <run-id> --json` in `cwd`. When the wait prints a
`finished`, `failed` or `stopped` outcome, the extension sends the message `workflow-result`, with the text of a
call without `background` for that outcome (the summary, with no report lines), the `details` `{ steps, outcome }`,
`display: true`, `triggerTurn: true` and `deliverAs: "followUp"`. It then appends the session entry
`workflow-background-end` with the data `{ runId }`. The renderer of `workflow-result` draws the steps and the outcome
as the tool result draws them, or the text of the message when its `details` are not valid.

At each `session_start`, the extension reads all the entries of the session, of every branch, and follows each run
whose last `workflow-background` entry comes after its last `workflow-background-end` entry. One extension instance
has at most one wait for a run, so a second `session_start` or a `background` resume of a followed run starts no
second wait. `session_shutdown` sends SIGINT to the waits, which detach and post nothing.

A `detached` or `host-stopped` outcome, an outcome line that is not valid, or no outcome line posts nothing and
appends no end entry, so the next `session_start` follows the run again. A crash between the message and the end entry
posts the outcome again at the next `session_start`.

A `save` call returns `{ runId, status: "finished", result: { file }, report: [file] }`, with the absolute path of the
file that it wrote. A `save` that fails is a normal tool error with the stderr text.

A failed, detached, stopped or host-stopped result is an error result that keeps `structuredContent`. Thus
`await tools.workflow({ name: "ship", args: { item } })` in a codemode script gets this object. A call that fails
before a run exists, such as an unknown workflow name, is a normal tool error with the stderr text.

## Run directory

Runs live in `$XDG_STATE_HOME/workflows/runs/<run-id>`, by default `~/.local/state/workflows/runs/<run-id>`:

- `project`: the name of the harness project whose store holds the run: its saved inputs, calls, sessions and progress

The project store is `$XDG_STATE_HOME/harness/<project>/durable.sqlite`. See [Runs in the harness
host](#runs-in-the-harness-host).

A ship run also has:

- `worktree/`: the worktree on `ship/<run-id>`, or on the branch that a shipped run renamed it to
- `repository/`: the clone, for a GitHub repository only
- `round-<n>.patch`, `round-<n>-fix.patch`: the patches each review got

A campaign run has `worktree/` on `campaign/<run-id>`, or on the branch that a done run renamed it to, and
`repository/` in the same way, plus:

- `item-<n>/`: the `round-<n>.patch` and `round-<n>-fix.patch` files of item `n`

An optimize run has:

- `baseline/<name>.md` and `best/<name>.md`: the baseline texts and the texts of the best candidate
- `prompts.diff`: the score lines and the diff

A child run that `run()` starts is a run directory of its own, next to the caller's, without a `project` file: it is a
task of the caller's run. A child run without a worktree can have an empty run directory.

## Prompts

`prompts/` holds the Pi prompt templates `research`, `plan`, `challenge`, `handoff`, `implement`, `review`, `judge` and
`commit`, `split`, `requeue` and `branch` for `campaign`, and `reflect` for `optimize`. Edit the wording there. Keep the
frontmatter and the last line `$@`: the run removes them, then adds its inputs as `## <name>` sections.
`workflows/ship.js` adds the evidence rule and the SHIP or FIX answer rule of the review challenge itself, so a template
edit cannot remove them. It also adds the `respond` answer rules of the handoff and implement turns. In the same way,
`workflows/campaign.js` adds the `respond` answer rule of `split` and `requeue`. The judge rubric is fixed: its eight
answers, in question order, make the score. `judge`, `commit` and `branch` hold their own `respond` answer rules. A run uses the
templates as they were when it started.

Workflow scripts get every template of `prompts/` as `prompts.<name>`, and the agent profiles of `agents/`. A run
uses the profiles as they were when it started.

## Source

The engine files in `src/`:

- `cli.ts`: the `workflows` command entry point.
- `harness.ts`: the check of the harness install and the path of the entry.
- `setup.ts`: the setup of a global install, for the command and the postinstall.
- `main.ts`: the commands `start`, `resume`, `stop`, `list`, `show`, `save` and `prune`, a client of the harness host,
  and the run directory.
- `entry.ts`: the entry that the harness host loads, with the script task.
- `progress.ts`: the tree of steps of a run, and how the command draws it on stderr.
- `store.ts`: the command's read-only reads of the project store: the tasks of the runs, their progress and calls.
- `meta.ts`: the `meta` of a workflow script, its arguments, its usage, `check`, and the report lines and exit code of
  a run.
- `task.ts`: the task of every script run, its saved input and checkpoint, its phase, child runs, and the end of its
  sessions.
- `script.ts`: the workflow script calls, agent profiles, prompts for scripts, and sessions on harness's children
  library.
- `run.ts`: the run ID, usage errors, and what a run gets from the command line.
- `git.ts`: Git commands, repository selection and worktrees.
- `prompts.ts`: the instructions of a prompt template.
