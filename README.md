# workflows

`workflows ship` ships a queue of markdown work items onto a new branch through
[Pi](https://github.com/earendil-works/pi-mono). Each item runs this loop, one fresh Pi session
per box:

```text
plan session:       plan  ->  challenge  ->  handoff
implement session:  implement the handoff                      <- round n (at most --rounds)
review session:     review  ->  challenge (SHIP or FIX)  ->  handoff (on FIX, back to implement)
```

Plan and review sessions are read-only; implement sessions can edit and run commands. Git is the
only state: there is no queue file, log, or saved program. `workflows optimize` improves the
prompts of that loop with GEPA.

## Setup

Requires Python 3.13, uv, Git, and `pi` on `PATH`.

```sh
uv sync
```

## Ship

```sh
uv run workflows ship --repo /absolute/path/to/repository --base main one.md two.md
```

Items ship in argument order onto `ship/<run>`, a new branch in a worktree under
`$XDG_STATE_HOME/workflows/runs/<run>/worktree` (default `~/.local/state/workflows`). The run
directory also keeps one folder per Pi session under `sessions/` (prompts, transcript, `pi.log`)
and each round's patches. Inside Herdr (`HERDR_ENV=1`) every session is a visible `pi` agent in a
new pane; elsewhere, or with `--headless`, sessions run with `pi --mode json`. Each item needs a
non-empty line, and every item is checked before the run starts.

After each implement session the engine commits everything as `round <n>`. A shipped item is
squashed into one commit, then a fixed judge reviews it in its own worktree:

```text
Item subject (first non-empty line of the item, without leading #)

<item text>

3 FAIL src/app.py:12 not needed by the work item

Rounds: 2
Judge: 0.83
```

The judge scores 0 when completeness or correctness fails, otherwise the fraction of its six
quality questions that pass. If the judge errors, or its reply misses an answer, the commit keeps
no `Judge` trailer.

An item that does not ship within `--rounds` stops the queue: its round commits and the worktree
stay, and the exit code is 1. To resume, run again with `--base <commit from the stop line>` and
the stopped item and the ones after it. That makes a new branch; `ship/<run>` and its worktree
stay until you delete them. Label an item by merging its commit into main or not.

## Optimize

```sh
uv run workflows optimize --repo /absolute/path/to/repository --base main --budget 40 one.md two.md
```

[GEPA](https://github.com/gepa-ai/gepa) rewrites the `plan`, `challenge`, `handoff`,
`implement` and `review` templates to raise the judge's score on the work items. A rollout ships
one item from `--base` in a fresh detached worktree under `rollouts/` in the run directory, for
at most `--rounds` rounds, and the judge scores it whether it shipped or stopped. Its findings,
and whether it shipped, are the feedback. After each rollout the worktree is removed and its
commits are on no branch. From the traces and feedback of a few rollouts, a read-only `reflect`
session in the repository proposes new instructions for one template at a time. `--rounds`,
`--pi`, `--headless` and `--run-dir` work as for `ship`, and every item is checked before the
run starts.

`--budget` counts rollouts. The baseline, today's templates, costs one rollout per item. Each
iteration then rolls out a minibatch of three items (repeating items when there are fewer) with
templates GEPA picks from its best so far, the same three with the proposal, and, when the
proposal scores higher, every item once more. With five or more items, GEPA may also merge two
improved candidates, which costs up to five rollouts, plus one per item when the merge scores
better. GEPA checks the budget only before an iteration, so the last iteration can overshoot it:
with one item, `--budget 4` runs one iteration and up to 8 rollouts.

A failed rollout, such as a Pi, git or judge error, stops the run with exit code 1 and names the
item; `prompts/` stays untouched. Run again with the same `--run-dir` to resume from GEPA's state
in its `gepa/` folder: a resumed run scores the baseline again (one rollout per item, not counted
in the budget), then redoes the iteration that was in flight.

When the budget is spent, each template GEPA changed is rewritten in this checkout's `prompts/`,
keeping its frontmatter and `$@`, and the command prints `changed prompts/<name>.md`. Templates
it did not change stay byte-identical. Review the result with `git diff prompts/`.

## Prompts

The six Pi prompt templates in `prompts/` are the engine's prompts: `plan`, `challenge`,
`handoff`, `implement` and `review` are the instructions of its DSPy predictors, and `judge` is
the fixed rubric. Edit them directly, but keep `$@` as the last line: Pi puts a command's
arguments there, and the engine drops it and appends its inputs as `## <name>` sections. The
engine also asks `challenge` for its final SHIP or FIX line itself, so no edit to the template can
drop it. Each predictor call also records the earlier turns of its session as a
`history` input, which Pi already holds and is not sent again, so `workflows optimize` sees what
every turn saw.

`pi install /home/vzl/Dev/workflows` makes them commands in interactive Pi, where `$@` takes the
arguments: `/plan`, `/challenge what's the move here`, `/handoff`, `/implement`, `/review`,
`/judge`.

## Development

```sh
uv run ruff format --check src tests && uv run ruff check src tests && uv run pytest
```

Tests use fake `pi` and `herdr` executables and temporary repositories; nothing calls a real
model.
