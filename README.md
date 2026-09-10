# workflows

A CLI that runs agent workflows through [Pi](https://github.com/earendil-works/pi-mono).
Workflows are DSPy modules. Pi is the DSPy language model: each LM call is one Pi session that
runs its own tools, and the final assistant message is the LM response. GEPA improves the learned
instructions of a workflow from real runs.

## Setup

Requires Python 3.13, uv, Git, and `pi` on `PATH`.

```sh
uv sync
uv run workflows list
```

## Run a workflow

```sh
uv run workflows campaign run --repo /absolute/path/to/repository --goal 'Implement the change'
uv run workflows campaign run --repo /absolute/path/to/repository --goal ./goal.md --base main \
  --criterion 'The change works' --command 'npm test'
```

`--goal` is literal text, or a file path when it exists or starts with `/`, `./`, or `../`.
Each run works in a detached Git worktree under `$XDG_STATE_HOME/workflows/runs/<run>/worktree`
(default `~/.local/state/workflows`). The run directory also keeps `state.json`, one folder per
Pi session under `sessions/` (transcript, prompts, `pi.log`), and check logs, the diff, and
`evidence.json` under `verification/`. Remove finished worktrees with `git worktree remove` or
`git worktree prune` in the source repository.

Inside Herdr (`HERDR_ENV=1`) every stage runs as a visible `pi` agent in a new pane beside the
current one. Elsewhere, or with `--headless`, stages run with `pi --mode json`.

`--program file.json` loads instructions saved by `optimize`. The exit code is 0 only when the
workflow completed.

## Optimize a workflow with GEPA

```sh
uv run workflows campaign optimize --cases cases.json --out campaign.json --max-metric-calls 6
```

`cases.json` is a list of objects with the workflow's input fields and an optional `split`
(`train`, the default, or `val`):

```json
[
  {
    "goal": "Add a --version flag",
    "repository": "/absolute/path/to/repository",
    "base": "a1b2c3d",
    "acceptance": { "criteria": ["--version prints the version"], "commands": ["npm test"] }
  }
]
```

Every metric call runs the complete workflow once in its own worktree. GEPA edits only the
instructions of the module's predictors; `--reflection-model` (a Pi model id) proposes them
through a tool-free Pi session. The result is saved with `dspy.Module.save`.

## The campaign workflow

`src/workflows/workflows/campaign.py`: plan -> implement -> review -> (fix -> review)* until the
review passes, at most `--rounds` reviews. Plan and review sessions get read-only tools;
implement and fix can edit and run commands. Before each review the workflow runs the recorded
verification commands, snapshots the tree, and asks a fixed tool-free evaluator. The campaign
completes only when the checks, the evaluator, and the learned review all pass on an unchanged
tree. Stage models, tools, skills, control text, and the evaluator are code; the signature
docstrings are the learned instructions. Stage skills are your installed Pi skills (`ponytail`
for plan and fix, `thermo-nuclear-code-quality-review` for review); the run fails before the
first stage when one is missing.

## Write a workflow

Add a module under `src/workflows/workflows/` and register it in `workflows/__init__.py`. It
exposes:

- `Workflow(dspy.Module)` whose `forward(**inputs)` returns a `dspy.Prediction` with `status`;
- `INPUTS`, the input field names of a case;
- `metric(gold, pred, ...)` returning a `dspy.Prediction(score=..., feedback=...)` for GEPA;
- `arguments(parser)` and `inputs(args)` for the `<name> run` command.

Use `workflows.pi.PiLM(pi, Agent(model, thinking, tools, skill), label)` as the LM inside
`dspy.context`. Set `lm.repair = True` to ask the open session once more for its JSON.

## Development

```sh
uv run ruff format --check src tests && uv run ruff check src tests && uv run pytest
```

Tests use a fake `pi` executable and temporary repositories; nothing calls a real model.
