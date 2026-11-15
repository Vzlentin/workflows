---
name: workflows
description: Use it when the user asks to ship, run a campaign, review, fix or judge a change, or asks about a workflows run, its status, its result, its worktree or its report.
---
# workflows

The `workflow` tool runs workflows. A run is headless and durable: its own sessions research, plan, implement, review
and judge. A run costs minutes and model calls.

## The rule

- Start a run, or resume one, only when the user asks for that run in his message. A contract or a goal file is not a
  go. To answer a question about workflows or about a run, read; do not start a run.
- Never plan, edit or commit in the run's worktree yourself while the run goes on. Never merge, push or delete its
  branch.
- Call the tool once for each run. Do not poll it, and do not call it again while it follows the run.
- Use the `workflow` tool, not `workflows` through bash, to start or resume a run. If the tool is not available, stop
  and tell the user.

## Choose the workflow

| The user wants | Workflow | Input |
| --- | --- | --- |
| one change, from an idea, an issue or a file, on a new branch | `ship` | `item` |
| a larger goal as a series of commits on one branch | `campaign` | `goal` |
| one change implemented in one commit, with no review loop | `rpi` | `item` |
| a review of a change that exists, with fixes in rounds | `thermoloop` | `change`, optional `item` |
| a score of a change that exists, with no edit | `judge` | `change`, optional `item` |

This skill does not cover `optimize`, `implement` or workflow scripts.

## Write the work item or the goal

`item` and `goal` take a `.md` file or the text itself. Use the first kind that matches:

1. **A Markdown file**: a path to a `.md` file that exists. Give its absolute path as it is.
2. **A GitHub issue**: `#N`, `N` or an issue URL. Read it with `gh issue view <input> --json number,title,body`.
   Write the work item as `# <title>`, a blank line, the body, a blank line, then `Closes #<number>`.
3. **An idea**: any other text. Write a `# ` heading that names the change in at most 70 characters, a blank line,
   then the text as the user wrote it. Do not plan or expand it.

Write a new work item to `${XDG_STATE_HOME:-$HOME/.local/state}/workflows/items/<slug>.md`, where `<slug>` is a short
kebab-case name that no file there has. Then the user can run a stopped item again. When the input names nothing, such
as a `.md` path that does not exist or an issue that `gh` cannot find, stop and ask.

## Call the tool

Each arg becomes a flag of `workflows <name>`. Give only the args that the user asks for:

```js
{ name: "ship", serves?: "<todo ID | parley slug>", args: { item: "<absolute path of the work item>", rounds?: 3, base?: "main", branch?: "<name>", repo?: "<path or owner/name>" } }
{ name: "campaign", serves?: "<todo ID | parley slug>", args: { goal: "<absolute path of the goal>", rounds?: 3, base?: "main", branch?: "<name>", repo?: "<path or owner/name>" } }
{ name: "rpi", serves?: "<todo ID | parley slug>", args: { item: "<absolute path of the work item>", base?: "main", branch?: "<name>", repo?: "<path or owner/name>" } }
{ name: "thermoloop", serves?: "<todo ID | parley slug>", args: { change?: "<change>", item?: "<work item>", base?: "main", rounds?: 3, repo?: "<absolute path of a local repository>" } }
{ name: "judge", serves?: "<todo ID | parley slug>", args: { change?: "<change>", item?: "<work item>", base?: "main", repo?: "<absolute path of a local repository>" } }
```

- `serves`: what the run builds: the ID of a todo of the list of the project, or the slug of an open parley or a
  contract. When the user names a todo or a parley for the work, give it; else leave it out. A todo that is done or
  dropped, or a parley that ended, fails the run.
- `repo`: without it, the run uses the Git repository of the current directory. A local path uses that repository.
  Write the path in full, with no `~`: the tool does not expand it. For ship, campaign and rpi only, any other value,
  such as `owner/name`, is cloned with `gh` into the run directory. For thermoloop and judge, `repo` is the top
  level of a local repository, and the run works in its checkout.
- `base` defaults to `main`. `rounds` defaults to 3: it is the maximum number of review rounds.
- `change`, for thermoloop and judge: nothing for the current branch against `base`, a number for that pull request,
  `A..B` for a range, or a ref such as `HEAD~1`. Without `item`, the intent is the pull request, or else the commit
  messages of the change.
- thermoloop commits its fixes on the branch of the change. When the user asks for a review only, use judge.
- `background: true` starts the run and returns at once with `state: "running"` and `follow: "started"`. The outcome comes later as a
  message in this conversation. Use it for a campaign, or when the user wants to go on with other work. Without it,
  the call waits until the run ends.

### Models

A run uses the Pi model and thinking level. `<repo>/.workflows/agents.json` and `~/.config/workflows/agents.json` set
them for each role name (`researcher`, `planner`, `implementer`, `reviewer`, `judge`, `summarizer`) or for `"*"`, as
`{ "judge": { "model": "<provider>/<id>", "thinking": "high" } }`. The repo table wins over the user table.
For one run, `args.agents` wins over both tables: `"*=<provider>/<id>:high,judge=:low"` (`*` is every role; leave
out the model or the thinking level to keep it from the tables).

## Read the outcome

The tool result has `runId` and `state`, the state of the run. A run that is `done` or `waiting` also has `result`,
`{ status?, code, score? }`, the status of the workflow, the exit code and the score of its last judge, if any, `value`, the whole result of the workflow, and
`report`, its report lines. Lead your report with the outcome.

| State | Meaning | What to tell the user |
| --- | --- | --- |
| `done` | The run ended with a result. `result.status` gives the outcome of the workflow, and `value` its fields. | See the next table. |
| `waiting` | The run asks a question. | See [A waiting run](#a-waiting-run). |
| `failed` | The run failed. `error` gives the reason, such as a Git hook or a model error after the retries. The text keeps at most 2000 bytes: a longer error keeps its first line and its end, with a line `[… <n> bytes cut; the command workflows log <runId> shows the run and its calls, and workflows log <runId> <call> prints the whole output of a call]`. | Quote the error, or the lines that `workflows log <runId>` prints. `workflows log <runId> <call>` prints the whole error of the failed call. `{ resume: "<runId>" }` continues the run. Do not resume it yourself. |
| `orphaned` | No host can run the task, such as a task of another version. `error` gives the reason. | Quote the reason. |
| `aborted` | `workflows stop` or a second Ctrl+C aborted the run. | `{ resume: "<runId>" }` continues it. |
| `running`, `follow: "started"` | A `background` call started the run. | The outcome comes as a message. |
| `running`, `follow: "detached"` | Esc detached the tool. The run goes on. | `{ resume: "<runId>" }` follows it again. |
| `running`, `follow: "host-stopped"` | The host stopped. The run continues when the host starts again. | `{ resume: "<runId>" }` follows it. |

A tool error before a run exists, such as bad usage, has no run ID. Quote the error.

The values of `result.status` for a `done` run. The fields that the table names, such as `branch`, are fields of
`value`. `result.code` is the exit code of the run, from the `meta.exit` of the workflow.

| Workflow | `result.status` | Give |
| --- | --- | --- |
| ship | `shipped` | The branch (`value.branch`, and the report line `branch <name>`), the rounds, the judge score and `value.findings`. The change is one squashed commit, and the judge judged that commit and its message. |
| ship | `rejected` | The judge scored the squashed commit 0. The commit and the branch stay. Give the branch and `value.findings`. |
| ship | `unjudged` | The judge gave no verdict: `value.judgeError` says why. The commit and the branch stay. |
| ship | `stopped` | The review rounds ended without SHIP. Give the worktree, the last patches and the findings of the last review. |
| ship, rpi, thermoloop | `blocked` | A round changed nothing. Give the worktree and `value.reply`, the implementer's reason. |
| campaign | `done` | The branch, one line for each item with its commit and score, and the score and findings of the campaign judge (`result.score` and `value.findings`). |
| campaign | `rejected`, `unjudged` | The campaign judge gave 0, or no verdict. The commits and the branch stay. Give the same lines as for `done`. |
| campaign | `stopped` | The user stopped the campaign at an item. Give the rundown when the result has one. |
| campaign | `waiting` | An item failed, or is still at judge 0, and the campaign asks how to continue. See below. |
| rpi | `implemented` | The commit `value.head` and the branch. |
| thermoloop | `approved` | The reviewer answered SHIP. Give `value.rounds` and the report line. |
| thermoloop | `stopped` | The rounds ended without SHIP. Give the findings of the last review. |
| judge | `judged` | `result.score`, from 0 to 1, and `value.findings`. |
| judge | `rejected` | The score is 0. Give `value.findings`. |
| judge | `unjudged` | The judge gave no verdict. Quote `value.judgeError`. |

Do not guess findings. To read the findings of the last review, use `workflows log <runId>`: it gives the steps, and
the review rounds are under the `run thermoloop` line. Then `workflows log <runId> <step>` gives the calls of one step,
with the step name at the end of its line, and `workflows log <runId> <call>` the full output of one call, with the
call name at the end of its line. `log` only reads.

### A waiting run

A run that waits for an answer has the state `waiting`, with its `question`. Show the question to the
user. A text longer than 2000 bytes is cut, and its cut line names `workflows log <runId>`, which shows the run and its calls, and `workflows log <runId> <call>`, which prints the whole question of the `input` call. When he answers, call `{ resume: "<runId>", answer: "<his answer>" }`. For a campaign, `stop`
ends it. For a campaign item still at judge 0, the answers are `keep` (ship it as it is), `fix: <words>` (one more fix
round on his words), `reset` (reset the item and get a rundown), and `stop` (end the campaign, keep the
commit).

## Follow a run

- `{ resume: "<runId>" }` follows a run that goes on, or continues one that ended without a result. Add `background:
  true` to return at once.
- `workflows list` gives the runs of this project, newest first, with their state and result, such as `done, result
  shipped exit 0`. `workflows list --json` also gives `resumable`, whether `resume` can take each run, the `question`
  of a waiting run, its `branch`, its `startedAt` and what it `serves`. `workflows show <runId>` gives the
  steps and the report of one run, and `workflows show <runId> --json` also gives its `agent`, the conversation and
  the project that `harness attach` opens. `workflows log <runId>` gives its steps with their times, call counts and sizes,
  and the calls that failed or still run, `workflows log <runId> <step>` the calls of one step with their exit codes
  and sizes, `workflows log <runId> <call>` the full output of one call, and `--follow` follows the run. Read the calls
  and the output of a run with `log`. These commands only read; run them with bash.
- The worktree of a local repository is `<parent>/.worktrees/<repository folder>/<runId>`, next to the repository.
  The branch is `<workflow>/<runId>` until a shipped run renames it from its commit subject.
- The run directory is `${XDG_STATE_HOME:-$HOME/.local/state}/workflows/runs/<runId>`. It holds the patches of each
  review, `round-<n>.patch` and `round-<n>-fix.patch`, and for a campaign `item-<n>/`.
- After a run's branch is merged or fast-forwarded onto `origin/main`, run `workflows sweep --yes` (or
  `workflows sweep <runId>... --yes` for a branch that went into another pull request or that you drop) to remove its
  worktree and its local branch. The sweep writes `landed` or `dropped` to the `swept` file of the run directory, and
  `list --json` and `show --json` give it as `swept`.

## /skill:workflows

With `/skill:workflows <workflow> <input>`, Pi adds the text after the command at the end of this skill. The first
word is the workflow, and the rest is its input: the work item for ship and rpi, the goal for campaign, and the change for
thermoloop and judge. Flags such as `--rounds 2` or `--base develop` become the args of the same name. The user asked
for the run, so start it. When the first word is not one of the five workflows, the whole text is the work item of
`ship`.
