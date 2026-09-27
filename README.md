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
only state: there is no queue file, log, or saved program.

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

## Prompts

The six Pi prompt templates in `prompts/` are the engine's prompts: `plan`, `challenge`,
`handoff`, `implement` and `review` are the instructions of its DSPy predictors, and `judge` is
the fixed rubric. Edit them directly, but keep `$@` as the last line: Pi puts a command's
arguments there, and the engine drops it and appends its inputs as `## <name>` sections. The
engine also asks `challenge` for its final SHIP or FIX line itself, so no edit to the template can
drop it. Each predictor call also records the earlier turns of its session as a
`history` input, which Pi already holds and is not sent again; a future GEPA pass sees what every
turn saw.

`pi install /home/vzl/Dev/workflows` makes them commands in interactive Pi, where `$@` takes the
arguments: `/plan`, `/challenge what's the move here`, `/handoff`, `/implement`, `/review`,
`/judge`.

## Development

```sh
uv run ruff format --check src tests && uv run ruff check src tests && uv run pytest
```

Tests use fake `pi` and `herdr` executables and temporary repositories; nothing calls a real
model.
