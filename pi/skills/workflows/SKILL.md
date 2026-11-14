---
name: workflows
description: Use it when the user asks to ship, run a campaign, review, fix or judge a change, or asks about a workflows run, its status, its result, its worktree or its report.
---
# workflows

The `workflow` tool runs workflows. A run is headless and durable: its own sessions research, plan, implement, review
and judge. A run costs minutes and model calls.

## The rule

- Start a run, or resume one, only when the user asks for it in his message. To answer a question about workflows or
  about a run, read; do not start a run.
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
{ name: "ship", args: { item: "<absolute path of the work item>", rounds?: 3, base?: "main", branch?: "<name>", repo?: "<path or owner/name>" } }
{ name: "campaign", args: { goal: "<absolute path of the goal>", rounds?: 3, base?: "main", branch?: "<name>", repo?: "<path or owner/name>" } }
{ name: "rpi", args: { item: "<absolute path of the work item>", base?: "main", branch?: "<name>", repo?: "<path or owner/name>" } }
{ name: "thermoloop", args: { change?: "<change>", item?: "<work item>", base?: "main", rounds?: 3, repo?: "<absolute path of a local repository>" } }
{ name: "judge", args: { change?: "<change>", item?: "<work item>", base?: "main", repo?: "<absolute path of a local repository>" } }
```

- `repo`: without it, the run uses the Git repository of the current directory. A local path uses that repository.
  Write the path in full, with no `~`: the tool does not expand it. For ship, campaign and rpi only, any other value,
  such as `owner/name`, is cloned with `gh` into the run directory. For thermoloop and judge, `repo` is the top
  level of a local repository, and the run works in its checkout.
- `base` defaults to `main`. `rounds` defaults to 3: it is the maximum number of review rounds.
- `change`, for thermoloop and judge: nothing for the current branch against `base`, a number for that pull request,
  `A..B` for a range, or a ref such as `HEAD~1`. Without `item`, the intent is the pull request, or else the commit
  messages of the change.
- thermoloop commits its fixes on the branch of the change. When the user asks for a review only, use judge.
- `background: true` starts the run and returns at once with the status `started`. The outcome comes later as a
  message in this conversation. Use it for a campaign, or when the user wants to go on with other work. Without it,
  the call waits until the run ends.

### Models

A run uses the Pi model and thinking level. `<repo>/.workflows/agents.json` and `~/.config/workflows/agents.json` set
them for each role name (`researcher`, `planner`, `implementer`, `reviewer`, `judge`, `summarizer`) or for `"*"`, as
`{ "judge": { "model": "<provider>/<id>", "thinking": "high" } }`. The repo table wins over the user table.
For one run, `args.agents` wins over both tables: `"*=<provider>/<id>:high,judge=:low"` (`*` is every role; leave
out the model or the thinking level to keep it from the tables).

## Read the outcome

The tool result is `{ runId, status, result?, report?, error? }`. Lead your report with the outcome.

| Tool status | Meaning | What to tell the user |
| --- | --- | --- |
| `finished` | The run ended. `result.status` gives the outcome of the workflow, and `report` its report lines. | See the next table. |
| `failed` | The run failed. `error` gives the reason, such as a Git hook or a model error after the retries. The text keeps at most 2000 bytes: a longer error keeps its first line and its end, with a line `[… <n> bytes cut; the command workflows log <runId> shows the run and its calls, and workflows log <runId> <call> prints the whole output of a call]`. | Quote the error, or the lines that `workflows log <runId>` prints. `workflows log <runId> <call>` prints the whole error of the failed call. `{ resume: "<runId>" }` continues the run. Do not resume it yourself. |
| `started` | A `background` call started the run. | The outcome comes as a message. |
| `detached` | Esc detached the tool. The run goes on. | `{ resume: "<runId>" }` follows it again. |
| `stopped` | `workflows stop` stopped the run. | `{ resume: "<runId>" }` continues it. |
| `host-stopped` | The host stopped. The run continues when the host starts again. | `{ resume: "<runId>" }` follows it. |

A tool error before a run exists, such as bad usage, has no run ID. Quote the error.

The values of `result.status` for a `finished` run:

| Workflow | `result.status` | Give |
| --- | --- | --- |
| ship | `shipped` | The branch (`result.branch`, and the report line `branch <name>`), the rounds, the judge score and `result.findings`. The change is one squashed commit, and the judge judged that commit and its message. A `judge failed` score means that the judge gave no verdict: `result.judgeError` says why. |
| ship | `stopped` | The review rounds ended without SHIP. Give the worktree, the last patches and the findings of the last review. |
| ship, rpi, thermoloop | `blocked` | A round changed nothing. Give the worktree and `result.reply`, the implementer's reason. |
| campaign | `done` | The branch, one line for each item with its commit and score, and the findings of the campaign judge. |
| campaign | `stopped` | The user stopped the campaign at an item. Give the rundown when the result has one. |
| campaign | `waiting` | An item failed, or is still at judge 0, and the campaign asks how to continue. See below. |
| rpi | `implemented` | The commit `result.head` and the branch. |
| thermoloop | `approved` | The reviewer answered SHIP. Give `result.rounds` and the report line. |
| thermoloop | `stopped` | The rounds ended without SHIP. Give the findings of the last review. |
| judge | `judged` | `result.score`, from 0 to 1, and `result.findings`. |
| judge | `unjudged` | The judge gave no verdict. Quote `result.judgeError`. |

Do not guess findings. To read the findings of the last review, use `workflows log <runId>`: it gives the steps, and
the review rounds are under the `run thermoloop` line. Then `workflows log <runId> <step>` gives the calls of one step,
with the step name at the end of its line, and `workflows log <runId> <call>` the full output of one call, with the
call name at the end of its line. `log` only reads.

### A waiting run

A run that waits for an answer is `finished` with `result: { status: "waiting", question }`. Show the question to the
user. A text longer than 2000 bytes is cut, and its cut line names `workflows log <runId>`, which shows the run and its calls, and `workflows log <runId> <call>`, which prints the whole question of the `input` call. When he answers, call `{ resume: "<runId>", answer: "<his answer>" }`. For a campaign, `stop` or an empty answer
ends it. For a campaign item still at judge 0, the answers are `keep` (ship it as it is), `fix: <words>` (one more fix
round on his words), `reset` (reset the item and get a rundown), and `stop` or empty (end the campaign, keep the
commit).

## Follow a run

- `{ resume: "<runId>" }` follows a run that goes on, or continues one that ended without a result. Add `background:
  true` to return at once.
- `workflows list` gives the runs of this project, newest first, with their status. `workflows show <runId>` gives the
  steps and the report of one run. `workflows log <runId>` gives its steps with their times, call counts and sizes,
  and the calls that failed or still run, `workflows log <runId> <step>` the calls of one step with their exit codes
  and sizes, `workflows log <runId> <call>` the full output of one call, and `--follow` follows the run. Read the calls
  and the output of a run with `log`. These commands only read; run them with bash.
- The worktree of a local repository is `<parent>/.worktrees/<repository folder>/<runId>`, next to the repository.
  The branch is `<workflow>/<runId>` until a shipped run renames it from its commit subject.
- The run directory is `${XDG_STATE_HOME:-$HOME/.local/state}/workflows/runs/<runId>`. It holds the patches of each
  review, `round-<n>.patch` and `round-<n>-fix.patch`, and for a campaign `item-<n>/`.
- After a run's branch is merged or fast-forwarded onto `origin/main`, run `workflows prune --yes` (or
  `workflows prune <runId>... --yes` for a branch that went into another pull request) to remove its worktree, its
  local branch, and its `hc` space terminals.

## /skill:workflows

With `/skill:workflows <workflow> <input>`, Pi adds the text after the command at the end of this skill. The first
word is the workflow, and the rest is its input: the work item for ship and rpi, the goal for campaign, and the change for
thermoloop and judge. Flags such as `--rounds 2` or `--base develop` become the args of the same name. The user asked
for the run, so start it. When the first word is not one of the five workflows, the whole text is the work item of
`ship`.
