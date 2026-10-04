# workflows

`workflows ship` ships one markdown work item onto a new branch through
[Pi](https://github.com/earendil-works/pi-mono). The item runs this loop, one fresh Pi session
per box:

```text
plan session:       plan  ->  challenge  ->  handoff
implement session:  implement the handoff                      <- round n (at most --rounds)
review session:     review  ->  challenge (SHIP or FIX)  ->  handoff (on FIX, back to implement)
```

Git is the only state: there is no state file, log, or saved program. `workflows campaign` splits
a goal into work items, then ships and merges them in order. `workflows optimize` improves the
prompts of that loop with GEPA.

Tool selection is the same in headless and Herdr sessions:

- Implement sessions omit `--tools` and use Pi's normal tool selection from its defaults,
  settings and extensions.
- Plan, review, split and reflect sessions use `--tools read,grep,find,ls`.
- Judge sessions use `--tools read,grep,find,ls,bash`.

## Setup

Requires Python 3.13, uv, Git, and `pi` on `PATH`.

```sh
uv sync
```

## Ship

```sh
uv run workflows ship --repo /absolute/path/to/repository --base main item.md
echo 'Fix the README typo' | uv run workflows ship --repo /absolute/path/to/repository /dev/stdin
```

The item is a markdown work item file; to ship text without a file, pipe it to `/dev/stdin`. The
output names the item by its subject.

The item ships onto `ship/<run>`, a new branch in a worktree under
`$XDG_STATE_HOME/workflows/runs/<run>/worktree` (default `~/.local/state/workflows`). The run
directory also keeps one folder per Pi session under `sessions/` (prompts, transcript, `pi.log`)
and each round's patches. Inside Herdr (`HERDR_ENV=1`) every session is a visible `pi` agent in a
new pane; elsewhere, or with `--headless`, sessions run with `pi --mode json`. The item needs a
non-empty line, checked before the run starts.

After each implement session the engine stages everything. If the staged tree matches the
round's starting commit, the run is blocked. The command prints
`blocked <item> after <n> rounds: <worktree>`, then the implementer's reply, and exits 1. That
attempt counts as a round, but makes no round commit or patch and opens no review or judge session.

Otherwise the engine commits any staged changes relative to current `HEAD` as `round <n>`.
Implementer commits are included in the round's patches and review. A shipped item is squashed
into one commit, then a fixed judge reviews it in its own worktree:

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

A blocked item or one that does not ship within `--rounds` keeps its earlier round commits and
the worktree, and the exit code is 1. Every run makes a new branch; `ship/<run>` and its worktree
stay until you delete them. For `ship`, label an item by merging its commit into main or not;
`campaign` merges its items itself.

## Campaign

```sh
uv run workflows campaign --repo /absolute/path/to/repository --base main goal.md
```

The goal is a markdown file, checked like a work item before the run starts. `--base` must be a
branch with a commit, checked out in the repository, and `--run-dir` must not exist yet. A
read-only `split` session, in a detached worktree at `--base` under `split/` in the run directory,
splits the goal into the ordered work items still needed; the run directory keeps them as
`items/<n>.md`. Each work item then ships from `--base`
as with `ship`, with its own run directory `<run>-<n>` inside the campaign's and the branch
`ship/<run>-<n>`. When the judge scores it above 0, the campaign merges it into `--base` in the
repository checkout with `git merge --ff-only`, removes its worktree and branch, and prints
`merged <item> into <base>`.

The campaign stops with exit code 1 at the first work item that is blocked or does not ship, that
the judge scores 0 or fails to score (`not merged <item>: judge <score>: <worktree>`), or that git
cannot fast-forward, for example over a local change to a file the item changes. That work item
keeps its branch and worktree; the checkout is never reset, and nothing is pushed. To resume, run
again with a new run directory (the default): the split starts from the updated base. When nothing
is left, the command prints `nothing left of <goal>` and exits 0. `--rounds`, `--pi` and
`--headless` work as for `ship`.

## Optimize

```sh
uv run workflows optimize --repo /absolute/path/to/repository --base main --budget 40 one.md two.md
```

[GEPA](https://github.com/gepa-ai/gepa) rewrites the `plan`, `challenge`, `handoff`,
`implement` and `review` templates to raise the judge's score on the work items. A rollout ships
one item from `--base` in a fresh detached worktree under `rollouts/` in the run directory, for
at most `--rounds` rounds. The judge scores shipped and round-limit-stopped rollouts; its findings
and whether it shipped are the feedback. A blocked rollout instead scores 0 without judging,
with the blocked explanation and implementer's reply as feedback. It is a valid outcome, not an
execution error. After each rollout the worktree is removed and its commits are on no branch.
From the traces and feedback of a few rollouts, a read-only `reflect` session in the repository
proposes new instructions for one template at a time. `--rounds`, `--pi`, `--headless` and
`--run-dir` work as for `ship`, and every item is checked before the run starts.

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

The seven Pi prompt templates in `prompts/` are the engine's prompts: `plan`, `challenge`,
`handoff`, `implement` and `review` are the instructions of its DSPy predictors, `split` is the
instructions of the campaign's split predictor, which `workflows optimize` does not change, and
`judge` is the fixed rubric. Edit them directly, but keep `$@` as the last line: Pi puts a
command's arguments there, and the engine drops it and appends its inputs as `## <name>` sections.
The engine also asks `challenge` for its final SHIP or FIX line, and `split` for its final fenced
`json` array of work items, itself, so no edit to a template can drop them. Each predictor call
also records the earlier turns of its session as a `history` input, which Pi already holds and is
not sent again, so `workflows optimize` sees what every turn saw. The review also receives the
implementer's reply as `reply`, alongside the patch paths in `change`.

`pi install /home/vzl/Dev/workflows` makes them commands in interactive Pi, where `$@` takes the
arguments: `/plan`, `/challenge what's the move here`, `/handoff`, `/implement`, `/review`,
`/split`, `/judge`.

## Development

```sh
uv run ruff format --check src tests && uv run ruff check src tests && uv run pytest
```

Tests use fake `pi` and `herdr` executables and temporary repositories; nothing calls a real
model.
