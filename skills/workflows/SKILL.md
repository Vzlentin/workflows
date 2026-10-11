---
name: workflows
description: Start, follow and resume durable workflow runs, such as shipping a work item onto a new branch with `ship`, shipping a goal as a queue of work items with `campaign`, searching for better ship prompts with `optimize`, or running a workflow script of agent turns and commands. Use when a task needs several sessions, review rounds, or a long run that must survive an interruption.
---

# Workflows

A workflow run is durable: it saves each model turn and each command, and it continues from where it stopped. Use
the `workflow` tool when work needs several sessions, a review loop, or many parallel agent turns. Do small work
directly.

## The `workflow` tool

Give exactly one of `name`, `script` or `resume`, plus `args`:

```js
await tools.workflow({ name: "ship", args: { item: "Fix the README typo", repo: "calibre", rounds: 2 } })
await tools.workflow({ name: "campaign", args: { goal: "goals/docs.md", rounds: 2 } })
await tools.workflow({ name: "optimize", args: { workflow: "ship", items: "items/", trials: 5 } })
await tools.workflow({ name: "review", args: { path: "src/lib" } })
await tools.workflow({ script: "return await agent('List the modules under src/')" })
await tools.workflow({ resume: "20261010T234930-3a93e88c" })
```

- `name: "ship"` ships `args.item` onto the branch `ship/<run-id>`. `repo`, `base`, `rounds` and `prompts`, a
  folder of prompts that replace the package prompts of their name, are optional, and any other arg is an error.
- `name: "campaign"` splits `args.goal` into work items and ships each one as a commit on the branch
  `campaign/<run-id>`. After each item, a planner updates the queue. `repo`, `base`, `rounds` and `prompts` are
  optional. The result is `{ status: "done", head, items: [{ item, result }] }` or `{ status: "stopped", items }`.
- `name: "optimize"` searches for better texts of the prompts of `args.workflow`, which is `ship`, over the work items
  of the folder `args.items`. `prompts`, the prompt names separated by commas, and `trials`, the number of candidates
  with the baseline, are optional. The result is `{ baseline, best, diff }`: the mean scores and the path of a diff to
  apply by hand.
- Any other `name` is a script in `workflows/` of the project's `.workflows/` or of the package. Each arg becomes the
  flag `--<key>`, and the script's `meta` declares the args it takes, with their types. An undeclared arg is an error.
- `script` is an inline workflow script.
- `resume` continues a run by its ID.

The run starts in the session's directory. The result is `{ runId, status, result?, error? }`. `status` is
`finished`, `failed` or `interrupted`. A failed or interrupted run is an error result that keeps this data, and it
stays resumable: call the tool again with `resume: runId`. Esc stops the run as Ctrl+C does.

## Workflow scripts

A script is the body of an async function, so top-level `await` and `return` work. It runs in the codemode sandbox,
with `agent`, `session`, `sh`, `ok`, `run`, `tools`, `prompts`, `parallel`, `pipeline`, `phase` and `log`. For the
meaning of each function, see [the script API](../../README.md#the-script-api).

Sandbox rules:

- No file system, network, modules or timers. Effects go through `sh`, `ok` and `tools`.
- `Date`, `Date.now()` and `Math.random()` throw, so that a script makes the same calls each time it runs.
- A resume runs the script again from the top. Calls that succeeded return their saved results. Commands in `sh`
  and `ok` must be safe to repeat.

## Command line

```sh
workflows ship [--repo <repository>] [--base <branch>] [--rounds <n>] [--prompts <folder>] [<item.md> | <text>] [--json]
workflows campaign [--repo <repository>] [--base <branch>] [--rounds <n>] [--prompts <folder>] [<goal.md> | <text>] [--json]
workflows optimize ship --items <folder> [--prompts <name,...>] [--trials <n>] [--json]
workflows <name | file.js | -> [<text>] [--<arg> <value>]... [--json]
workflows <name> --help
workflows check <name>
workflows
workflows resume <run-id> [--json]
workflows list [--json]
```

In Pi, `/workflows` lists the runs, and `/workflows resume <run-id>` asks the agent to continue one with the tool.
