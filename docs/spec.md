# workflows reference

The behaviour of the `workflows` command, the workflow scripts, runs and the `workflow` tool. The
[README](../README.md) has the install.

`workflows ship` ships one work item onto a new branch through [Pi](https://github.com/earendil-works/pi) sessions.
`workflows campaign` splits a goal into work items and ships them one after another onto one branch.
`workflows rpi` researches, plans and implements one work item in one commit, `workflows thermoloop` reviews a change
(the current branch, a PR, a ref or a range) and fixes it in rounds, and `workflows judge` judges it.
`workflows optimize ship` proposes edits to the ship prompts, profiles, skills and `AGENTS.md` from past ship runs,
and keeps them when a blind judge prefers the diffs they give. The run is
headless and resumable. It runs in the [harness](https://github.com/Vzlentin/harness) host of its project, whose
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) store keeps the sessions, model calls, tool
calls and the progress of the run. See [Runs in the harness host](#runs-in-the-harness-host).

`src/` is the engine that runs workflows: run directories, the script task, sessions, retries, resume and
workflow scripts. Every workflow script is a command: `workflows <wf>` runs `.workflows/scripts/<wf>.js` of the project or `workflows/scripts/<wf>.js` of the package, and the `meta` at
the top of the script declares its arguments. See [Workflow scripts](#workflow-scripts). `workflows/scripts/ship.js` and
`workflows/scripts/campaign.js` are scripts of the package. `ship` selects the repository and creates the worktree, through its
`meta`, then runs in the worktree the child runs `workflows/scripts/rpi.js`, `workflows/scripts/thermoloop.js` and `workflows/scripts/judge.js`,
and the squash. `campaign` does the same, runs
`workflows/scripts/ship.js` once for each work item, and `workflows/scripts/judge.js` once on the change of all the items.
`workflows/scripts/optimize.js` runs `workflows/scripts/ship.js` once for the candidate on each work item, and again
for a baseline that cannot be kept.

```text
research session:   research (documents the code as it is)
plan session:       plan (with the research)  ->  handoff
implement session:  implement the handoff                      <- round 1, then each round after FIX
review session:     review (SHIP or FIX)  ->  handoff (on FIX, back to implement)
judge session:      fixed rubric, then commit message, after SHIP
```

The research, plan and first implement sessions are `workflows/scripts/rpi.js`, the review sessions and the implement
sessions after them `workflows/scripts/thermoloop.js` (at most `--rounds` reviews), and the judge session `workflows/scripts/judge.js`.
Each implement session is a child run of `workflows/scripts/implement.js`, which `rpi.js` and `thermoloop.js` both run.

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
defaults to 3. `--branch <name>` gives the name of the run's branch: see
[Branch name](#branch-name).

`--prompts <folder>`, relative to the current directory, gives prompts for this run: each `<name>.md` in the folder
replaces the package prompt `prompts/<name>.md`, in the same template format. A missing folder, or a file with no
package prompt of that name, fails before the run starts. The run saves the prompts that it used, as any run does.
`campaign` and `optimize` take the same option; an `optimize` over past runs takes its baselines and the texts it
edits from the saved runs instead. As a child run, it also takes `overlay`, and gives it to its child runs: see [Child runs](#child-runs).

Without `--repo`, the run uses the Git repository that contains the current directory. With `--repo`, the value is
first a path, relative to the current directory. If that path is the top level of a local Git repository, the run
uses it and its local `--base` commit. Otherwise `gh repo clone <value>` clones the repository into the run
directory, and the run starts from the cloned `origin/<base>`. A bare name such as `calibre` clones from the
authenticated user, and `owner/calibre` names the owner.

The command prints `run <run-id>`, then the progress steps of its child runs on stderr as each one starts: `research`,
`plan` and `implement` of the [rpi](#rpi) child run, `round <n>/<rounds>: review` and `round <n>/<rounds>: implement`
of the [thermoloop](#thermoloop) child run, and `judge` of the [judge](#judge) child run. Ship has no steps of its own.
See [Progress](#progress) for how the steps show. A resume prints the phase line of the first call that runs, such as
a turn or a Git step, and the lines after it.

Each implement step logs the size of the round's change, `+<insertions> -<deletions> in <n> file(s)` or `no new
changes`; each review step logs `SHIP` or `FIX`; the judge step logs `judge <score>`. After the squash, the run logs
`commit <commit> <subject>`, or `nothing to commit since <commit>` when the work changed nothing since its start. See the example of [Campaign](#campaign).

The research session gets the work item and writes a research document: what the code that the work item touches
does today, with `path:line` references, the patterns and tests of that area, and open questions. It documents and
does not suggest changes, and if it has a subagent tool, can spawn subagents to search in parallel. The plan prompt
gets its reply as its `research` section, after the work item. The research prompt has no memory and gives no notes.

The work item ships onto the branch `ship/<run-id>`, or `--branch`, in a worktree next to the repository (see [The meta block](#meta)), and a shipped run renames that
branch at the end: see [Branch name](#branch-name). The selected repository's checkout, index and local edits stay
unchanged. Ship does not push and does not open a pull request.

The run starts the child run `rpi` in the worktree with the work item and the start commit: see [RPI](#rpi). When
it is blocked, the run prints `blocked <subject> after 1 rounds: <worktree>` and the implementer's reply, and exits 1.
Then it starts the child run `thermoloop` in the worktree, with the work item, `--rounds`, the start commit, and the
plan and the reply of `rpi`: see [Thermoloop](#thermoloop). The thermoloop writes its patches in the run directory
of ship. When the thermoloop is blocked, the run prints `blocked <subject> after <n> rounds: <worktree>` and the
implementer's reply, and exits 1. A run whose thermoloop stopped after `--rounds` rounds prints
`stopped <subject> after <n> rounds: <worktree>` and exits 1.

The run keeps a memory of notes in an [OptMem](https://github.com/VictorTaelin/OptMem) store, `memory/` in the run
directory, through the user's `$HOME/.optmem/memo` with `MEMORY_DIR` set to the store. `ship` opens the store with
`memo init` and `memo config PART_CHARS=100000`, so that `memo wake` gives all its lines in one part, and gives its
`ref` (its path, whether it is plain, and the campaign item) to `rpi` and `thermoloop`; a child run that gets a `ref`
opens nothing. Without `memo` when the store opens, the store is the plain file `memory/notes.txt`, with one `#<k>
<note>` line for each note and no summaries. Each note has the key `<run-id>/<n>`, the `<n>`th note that the run added,
as one line of `memory/notes.keys`, and `<k>` is the line of its key, from 0. So an add that runs again at resume adds
no line, and adds that run at the same time get different numbers. The run logs `memo of OptMem is missing, so the run memory keeps
plain notes without summaries. Install it with: curl -fsSL
https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh`. The runs that get the `ref` of a plain
store keep it plain. A `memo` call on an OptMem store whose `memo` is gone fails with `workflows: memo of OptMem is
missing at <path>. Install it with: <install command>`.

The planner's handoff, each implement turn and the reviewer's handoff answer through `respond` with their text and a
list of notes, each one line of at most 280 bytes: the planner gives its decisions with their reasons, the
implementer gives what it tried and what it observed, and the reviewer gives what its review checked and found sound,
and the lessons that later work needs, but not its findings, which its handoff gives. The reviewer has no handoff on
SHIP or on FIX in the last round, so it gives no notes then. Each note becomes one `memo note` of the line
`[item <n> ]<author>[ r<round>]: <note>`, with its whitespace collapsed, where the author is `planner`, `implementer`
or `reviewer`, the item is the campaign item, and the planner has no round. Empty notes are left out, and a line above
280 UTF-8 bytes loses words from its end. When `memo` asks to compress notes, a `summarizer` session answers with one
line, cut in the same way, which goes to `memo nap`.

The first prompt of each planner, implement and review session starts with a `## memory` section with the lines of
`memo wake` that start with `#<k>` or `#<lo>-<hi>`, without the date of a note, when there are any. The later prompts of
the session have no section. The judge's prompt has no memory. The saved results of the `memo` calls replay at
resume, so a resume gives the same prompts.

A ship run that opened its own run memory, and not a campaign item, which gets the memory of its campaign, ends with
the harvest of `.finish(item, result)`, at each end: shipped, blocked or stopped. When the memory has notes, one `summarizer` session gets the
`harvest` prompt with the work item, the outcome (the result without its `report` and `memory` keys, also in its items, as JSON), the run ID and
the notes, and answers through `respond` with `lessons`: 0 to 3 objects of `cue`, when the lesson applies, `lesson`,
what to do instead of what, and `evidence`, `run:<run ID>` or a `#conv` ID with the note numbers. The default answer is
`[]`. With no notes, no turn runs and the lessons are `[]`. A note row that says `confounded yes` (see
[Optimize](#optimize)) cannot tell which change made its verdict, and the prompt gives no lesson that rests only on such
rows. The harvest does not change the notes. Each lesson adds the
report line `  lesson <cue>: <lesson> (<evidence>)`, with the whitespace runs of each field made one space, after the
other report lines of the script and before `branch <name>`.

On SHIP, the run starts the child run `judge` in the worktree, with the work item, the start commit and `commit:
true`: see [Judge](#judge). If the judge fails or does not answer through `respond`, the command prints
`judge failed on <subject>: <error>` on stderr.

When the judge answered, the same judge session then gets the `commit` prompt, and answers through `respond` with
`subject`, `body` and `divergence`: a commit message that follows the commit rules of the repository, and one line
that tells how the delivered commit differs from the work item, or exactly `none`. The run squashes the work into one
commit with the message `<subject>`, an empty line, then `<body>`:

```text
fix: correct the README typo

The README said wrold. It now says world.
```

The divergence is not in the commit message.

If the judge failed, or the message turn fails or answers an empty `subject`, the message is the subject of the work
item alone: its first non-empty line without leading `#`. A failed message turn prints nothing and does not change the
score.

The command prints `shipped <subject> in <n> rounds, judge <score or failed>, <commit>`, then the line `branch <name>`
of [Branch name](#branch-name), and exits 0.

The result of the run, which `--json` prints, has `status` and `rounds`; `head`, `subject`, the subject of the
squashed commit, and `branch`, the branch that the worktree ends on, when shipped; `worktree`, the path of the
directory that the run ran in, for every status; `score`, `answers`, the eight answers in question order, and `findings`, the finding
lines of the judge, when the judge answered; `judgeError` when the judge failed; `divergence`, the divergence line of
the commit turn with its whitespace runs made one space, when shipped and that turn answered with a non-empty subject; `reply` when blocked; `handoff`, the
handoff that the last round used, when blocked or stopped; `memory`, the
notes of the run memory in order as `#<k> <note>` lines, or `[]` when there are none, for every status; and `lessons`,
the lessons of the harvest, for every status of a ship run that is not a campaign item.

Blocked and stopped runs keep their branch, worktree and round commits. Delete them when you no longer need them.

## RPI

```sh
workflows rpi "Fix the README typo"
workflows rpi --repo calibre --base develop item.md
```

`workflows rpi` researches, plans and implements one work item, and commits it on its branch: the research, plan and
first implement of `ship`, with no review, no judge and no squash. The work item, `--repo`, `--base`, `--branch` and
`--prompts` work as for `ship`. The work goes in a worktree next to the repository on the branch `rpi/<run-id>`, or
`--branch`, which keeps its name. The steps are `research`, `plan` and `implement`. As a child run, it also takes `overlay`, and gives it to its child runs: see [Child runs](#child-runs).

The research and plan sessions are those of `ship`. The step `implement` runs [implement](#implement) as a child
run, with the planner's handoff as the plan, round 1, the start commit, the subject of the work item as the message,
and the `ref` of the run memory. When the branch has no change from the start commit, the run is blocked: it prints
`blocked <subject>` and the implementer's reply, and exits 1. Otherwise the implement step logs the size of the
change, and the command prints `implemented <subject>, <commit>` and exits 0.

Without a caller, the run opens its own store, as `ship` does, and ends with the harvest of `ship` at each end:
implemented or blocked. Its result then has `lessons`, and the report has a line for each lesson.

The result has `status` (`implemented` or `blocked`), `memory`, the notes of the store as `#<k> <note>` lines, and
`reply`, from the implement result. When implemented, it has `head` and `plan`, the planner's handoff; when blocked,
`rounds`, which is 1, and `handoff`, the planner's handoff, as a blocked thermoloop has.

## Implement

```sh
workflows implement plan.md
workflows implement --message "fix: the typo" --round 2 plan.md
```

`workflows implement` follows a plan in one implement session, and commits the change in the current directory. It
has no worktree of its own and no step of its own: as a child run, it runs in the directory of its caller, and its
log line goes under the step of its caller. The plan comes as the work item of `ship` does. `--message` is the commit
message, by default the subject of the plan, and `--round`, default 1, is the round of the implementer's notes. A
caller also gives `start`, the commit that the change starts from, and `memory`, the `ref` of a run memory to go on
with. Without `memory`, the run opens its own store, as `ship` does. Without `start`, a checkout with changes that
are not committed fails with `the checkout has changes that are not committed; commit or stash them first` before any
session, and `start` is `HEAD`. As a child run, it also takes `overlay`: see [Child runs](#child-runs).

The `implementer` session gets the `implement` prompt with the plan, after the notes of the memory, and gives its
report and notes. The run stages all changes and commits them as the message, when something is staged. Commits that
the implementer made are kept. When the branch has no change from `start`, the run is blocked: it prints
`blocked <subject>` and the implementer's reply, and exits 1. Otherwise it logs the size of the change from the
`HEAD` before the session, `+<insertions> -<deletions> in <n> file(s)` or `no new changes`, prints
`implemented <subject>, <commit>` and exits 0. `<subject>` is the subject of the plan.

The result has `status` (`implemented` or `blocked`), `reply`, the implementer's report, `memory`, the notes of the store
as `#<k> <note>` lines, and `head`, the short commit, when implemented.

## Fix

```sh
workflows fix --start 1a2b3c4 item.md
```

`workflows fix` is the fix round of a work item that a judge scored 0, in the current directory. It has no worktree of
its own. Its step is `fix`. `--start`, which it needs, is the commit that the change of the item starts from, and
`--round`, default 1, is the round of the implementer's notes. A caller, as `campaign` is, also gives `findings`, the
judge's findings as a list of lines, `message`, the commit message of the fix, and `memory`, the `ref` of a run memory
to go on with. It runs the child run `implement` with the work item, then `## Judge findings` with one `- <finding>`
line for each finding, as the plan, from the commit of `HEAD`, and then the child run `judge` on the change from
`--start`.

The result is `{ "status": "judged", "score", "answers", "findings", "reply" }`, and the command prints
`judge <score>: <subject>` and one line `  <finding>` for each finding, and exits 0. When the implement is blocked, the
result is `{ "status": "blocked", "reply" }` and the command prints `blocked <subject>` and the reply. When the judge
gives no score, the result is `{ "status": "unjudged", "judgeError", "reply" }` and the command prints `judge failed
on <subject>: <error>`. When a child run fails, the run does not fail: the result is `{ "status": "failed", "error" }`,
with `reply` when the implement ended, and the command prints `fix failed on <subject>: <error>`. So a caller saves the
result, and a resume does not run the fix round again. These three exit 1. A child run that was stopped, whose error
is `child run <id> stopped: <reason>`, fails the run with that error, so that a resume of the caller runs it again.

## Thermoloop

```sh
workflows thermoloop
workflows thermoloop 74
workflows thermoloop HEAD~1 --item "Fix the README typo"
workflows thermoloop main..feature --rounds 2
```

`workflows thermoloop [<change>]`, the review loop, reviews a change and fixes it in rounds until the reviewer
answers SHIP. It commits its fixes on the branch of the change and does not push. `--base` defaults to `main` and
`--rounds` to 3. As a child run, it also takes `overlay`, and gives it to its child runs: see [Child runs](#child-runs). The one optional argument says what the change is:

- Nothing: the current branch, from the merge base of `--base` and `HEAD` to `HEAD`.
- A number: the pull request with that number. The run reads it with `gh pr view <n> --json
  number,title,body,headRefName,baseRefName,isCrossRepository`, and fails when `gh` fails. Its branch is
  `headRefName`, or `pr/<n>` for a pull request from a fork. The run always fetches the head of the pull request with `git fetch
  origin pull/<n>/head`. It puts the branch on that head with `git branch -f <branch> <head>` when the branch is missing
  or behind the head, and uses a branch that is at the head or ahead of it as it is. It fails with `<branch> has
  diverged from PR #<n>; rebase it or delete it` when the branch and the head have diverged, and with `<branch> is behind
  PR #<n> and checked out at <path>; update it there` when a worktree has the branch that is behind. The change starts at
  the merge base of the branch with `baseRefName`, or with `origin/<baseRefName>` when there is no local branch of
  that name; `--base` is not used.
- A range `A..B` or `A...B`: from the merge base of `A` and `B` to `B`.
- Any other value is a ref: from the merge base of the ref and `HEAD` to `HEAD`, such as `HEAD~1` for the last commit.

The work item, which says what the change should do, is the option `--item`, as a `.md` file, inline text, or stdin
with the rules of `ship`. A blank stdin counts as no work item. Without it, the intent is `# <title>` and the body of
the pull request: of the number, or else of the branch of the change through `gh pr view <branch> --json title,body`.
When there is no pull request or `gh` fails, the intent is the commit messages of the change, oldest first.

The run works in the current checkout when the change ends on its `HEAD` or on its current branch. There, it first
commits the changes that are not committed, untracked files included, as one commit `wip`. When the change ends on
a branch that no worktree has checked out, such as a pull request that is not checked out here, the run starts itself
again as a child run with `checkout` in a worktree on that branch, next to the repository, as `meta.worktree` places
it: see [Child runs](#child-runs). Its report gets the last line `worktree <path>`, and the current checkout stays as
it is. The run worktree stays after the run. A branch that another worktree has checked out fails with `<branch> is
checked out at <path>; run there`, and a change that does not end on a branch, such as `main..<commit>`, fails with
`<end> is not a branch, and the fixes need one`. A change with no change from its start fails with `no change from
<from>`, where `<from>` is `--base`, the base branch of the pull request, or `A` of the range or the ref, before any
session.

Each round reviews the change, and on FIX the reviewer's handoff is implemented as the next round. So each round
has the step `round <n>/<rounds>: review`, after `round <n>/<rounds>: implement` from round 2.
`ship` gives the script `start`, the commit that the change starts from, and `item`, so the script does none of the
steps above, and `plan`, `reply` from `rpi`, which the first review gets, and `memory`, the `ref` of its run memory.

The step `round <n>/<rounds>: implement` runs [implement](#implement) as a child run, with the handoff as the plan,
round `<n>`, the commit of `HEAD` before the round as the start commit, the message `round <n>` and the `ref` of the run memory:

- If the implement run is blocked, as a round that changes nothing is, the thermoloop is blocked. It prints `blocked <subject> after <n> rounds` and
  the implementer's reply, and exits 1.
- Otherwise new staged changes are the commit `round <n>`. Commits that the implementer made are kept. A round
  without new changes still goes to review when earlier changes remain.

The implement step logs the size of the round's change, `+<insertions> -<deletions> in <n> file(s)` or `no new
changes`, and the review step logs `SHIP` or `FIX`. The review session gets the work item, the handoff that the
last implement session followed, the implementer's reply (both none in round 1 without a caller), and the paths of
the round's patches in the run directory, or in the `patches` folder that `ship` gives: `round-<n>.patch` from the start
commit, and from round 2 `round-<n>-fix.patch` from the previous round. From round 2, the prompt also gets a `## scope`
section: the review covers only the fix patch, and a finding is a part of the plan that is not done, a problem that the
fix added, or a reproduced bug, so the rounds end. The review turn ends with SHIP or FIX through `respond`: SHIP when
the review has no finding, FIX when it has one or more. On FIX, its handoff gives every finding with its fix, and the
next round fixes all of them.

On SHIP, the command prints `approved <subject> in <n> rounds, <commit>` and exits 0. A run that is not approved
after `--rounds` rounds prints `stopped <subject> after <n> rounds` and exits 1. The memory works as in `ship`, in the store
that `ship` gives, or in its own store without a caller. The result has `status` (`approved`, `blocked` or `stopped`),
`rounds`, `handoff`, the handoff that the last round used, `memory`, and `reply` when blocked. Without a caller, the run
ends with the harvest of `ship` at each end: approved, stopped or blocked. Its result then has `lessons`, and the report
has a line for each lesson. A run that runs again in a worktree gives the lessons of that child run.

## Judge

```sh
workflows judge
workflows judge 74
workflows judge main..feature --item item.md
```

`workflows judge [<change>]` judges a change against its intent with the fixed rubric of `prompts/judge.md`. The
change, `--base`, `--item`, the intent and the worktree of a change on another branch are as in
[Thermoloop](#thermoloop). The judge changes nothing: it commits no `wip`, and when the checkout has changes that are
not committed, it logs `uncommitted changes are not judged` and adds that line at the end of its report. `ship`, `fix` and
`campaign` give it `start`, the commit that the change starts from, and `item`. Its step is `judge`. As a child
run, it also takes `overlay`: see [Child runs](#child-runs).

The judge session answers through `respond`: eight PASS or FAIL answers, and one finding line for each failed
question. If question 1 (complete) or 2 (correct) fails, the score is 0. Otherwise the score is the fraction of
questions 3 to 8 that pass. The step logs `judge <score>`. The command prints `judge <score>: <subject>`, then one
line `  <finding>` for each
finding, and exits 0. The result is `{ "status": "judged", "score", "answers", "findings" }`. With `commit: true`,
which `ship` gives, the same session then gets the `commit` prompt, and the result has `commit`, `{ subject, body, divergence }`,
when that turn answered with a non-empty subject.

If the judge fails or does not answer through `respond`, the run logs and prints `judge failed on <subject>: <error>`,
and exits 1. The result is `{ "status": "unjudged", "judgeError" }`.

## Campaign

```sh
workflows campaign goal.md
workflows campaign --repo calibre --base develop --rounds 2 "Make the docs complete"
```

The goal comes from one argument or from stdin, as the work item of `ship` does, and `--repo`, `--base`, `--rounds`
and `--prompts` work as for `ship`. `--rounds` applies to each work item. Errors name the goal, such as `the goal is empty`.
When the judge of an item fails, the command prints `judge failed on <item subject>: <error>` on stderr, as `ship` does.

In the step `split`, a planner session splits the goal into work items with the `split` prompt, and answers through
`respond` with a `subject`, a Conventional Commit subject for the whole goal, and the work items. The step logs the
number of items, such as `2 items`. Then each
work item ships in turn, in one worktree on the branch `campaign/<run-id>`, or `--branch`: the research, the plan, the rounds, the
review, the judge and the squash of `workflows/scripts/ship.js`, from the commit that the item before it made. So each shipped
item is one commit, with the commit message that its own judge wrote, as in `ship`. No `ship/<run-id>` branch is made,
and nothing is merged or pushed. Each item is a ship child run, with its own
run ID and run directory, in the store of the campaign run: see `run` in [the script API](#the-script-api).

After the split, the campaign opens one run memory, the store `memory/` in its run directory, as `ship` does, and
gives its path and the item number to each ship. So the notes of an item are `item <n> <author>...` lines, and the
sessions of the next items see them.

The items of the split do not change while they ship. Only a failed item changes them: see below.

The campaign ends with the harvest of `ship`, with the goal as the work item, at each end: done or stopped. It makes no
harvest while it waits for an answer. Its result then has `lessons`, and its items make no harvest and have no
`lessons`.

The command prints `run <run-id>`, the step `split`, then the step `item <n>/<total>: <subject>` on stderr before the
steps of each item, and the step `all <n> item(s)`, with the step `judge` of the campaign judge under it, when every
item shipped.
`<total>` is the number of items known when the item starts: the items that ran before it, this item, and the items of
the split after it. The steps and log lines of the item's ship run are under the item step, indented by 2:

```text
✓ split  12s
  2 items
✓ item 1/2: Fix the README typo  4m03s
  ✓ research  31s
  ✓ plan  48s
  ✓ implement  1m50s
    +1 -1 in 1 file
  ✓ round 1/3: review  35s
    SHIP
  ✓ judge  19s
    judge 0.83
  commit a1b2c3d fix: correct the README typo
◉ item 2/2: Add a thanks line
  ✓ research  28s
  ◉ plan
```

See [Progress](#progress). At resume, the first steps of the item it continues can come before the item step. On a
terminal and in Pi they move under the item step when it comes.

- At the start of each item and before the run ends, the run checks that the worktree is on the branch that it had
  at the start of the campaign. When `HEAD` is detached or on another branch, and `HEAD` contains the last shipped commit, or the start commit when no item shipped, the run moves the campaign
  branch to `HEAD` and checks it out with `git checkout -B <branch>`. Otherwise the run fails with `the campaign
  worktree is not on <branch> (HEAD <commit>), and HEAD does not contain the last shipped commit: check out the
  campaign branch and resume`. So the result always has a `branch`.
- When every item shipped, the step `all <n> item(s)` runs the child run `judge` on the change of the whole campaign,
  from the start commit to the last item, against the goal: the judge of an item sees only its item, and not how the
  items fit together. The command prints
  `done <subject> in <n> item(s), judge <score or failed>, <commit>` with the commit of the last item, then one line
  `  <commit> <commit subject>, judge <score or failed>` for each shipped item, in order, with
  `, divergence <divergence>` at the end when the item's divergence is there, not empty and not `none`, then one line
  `  finding <finding>` for each finding of the campaign judge, then the lesson lines, then the line `branch <name>` of
  [Branch name](#branch-name), with the `subject` of the last split, and exits 0. The score of the campaign judge does
  not change the outcome.

- When an item ships with a judge score of 0 and the judge gave findings, the item gets one fix round. The run reads
  the item's commit message, then runs the child run [`fix`](#fix) with the work item, `start` at the commit that the
  item started from, the judge's findings, `round` at the rounds of the item plus 1, the message `fix: judge findings
  of item <n>` and the run memory of the item. When `fix` is judged with a score above 0, the run squashes the change
  of the item again into one commit with the item's message, logs `commit <commit> <commit subject>`, and the item
  ships: its result is the ship result with the new `head`, `score`, `answers` and `findings`. The step `fix` comes
  under the item step, its `judge` step under it, and the log line under the item step:

  ```text
  ✓ item 1/2: Fix the README typo  6m12s
    ...
    ✓ judge  19s
      judge 0.00
    commit a1b2c3d fix: correct the README typo
    ✓ fix  1m20s
      +1 -1 in 1 file
      ✓ judge  18s
        judge 0.83
    commit b2c3d4e fix: correct the README typo
  ```

  Otherwise the fix round fails with an outcome: `the fix round failed: <error>` when `fix` is `failed`, `the fix
  round changed nothing` when it is `blocked`, `no judge score after one fix round` when it is `unjudged`, `still 0
  after one fix round` when the score is 0 again, and `the fix round ended with the unknown status <status>` for any
  other status. Then the item fails as below.
- When an item is blocked or stopped, ships with a judge score of 0 and no fix round ships it, or ships with a judge
  that failed, the item fails, with no fix round when the judge failed. The run writes the change of the item, from
  the commit that the item started from to `HEAD`, as `item-<n>/item.patch` in the run directory. It checks that the
  commit that the item started from is the last shipped commit, or the start commit when no item shipped, and that
  `HEAD` contains it; else the run fails with `HEAD <commit> does not contain the last shipped commit <commit>: the
  campaign does not reset it`. Then it resets the worktree with `git reset --hard` to that commit, and adds the note `campaign: item <n>
failed and was reset: its notes describe code that is gone` to the run memory. Then a new planner session gets the
  `rundown` prompt with the inputs `goal`, `shipped` (the shipped items, each one as `{ item, commit, divergence }`, as JSON), `item`, `status`
  (the ship status, `shipped with a failed judge: <judge error>`, or `shipped with judge score 0`, with `, <outcome>`
  of the fix round after it when the item had one), `reply` (the reply of the fix round's implementer after a fix round that has one), `handoff`, `findings` (the findings of the
  fix round's judge when it gave some), `memory` (the notes of the run memory of the campaign, as `#<k> <note>` lines), `remaining` (the
  remaining items, as JSON) and `patch` (the path of `item-<n>/item.patch`, when the item changed something). Empty inputs are left out. It answers through `respond` with a rundown, suggestions and proposed items.
  The run asks the question of [Input](#input): the question summary, which is the rundown, after a fix round
  `Fix round: <outcome>` with one `- <finding>` line for each finding of the fix round's judge, `Suggestions:` with one
  `- <suggestion>` line each, `Proposed items:` with the numbered items, and `Patch of the failed item: <path>` when
  the patch exists, then `How should the campaign continue? Answer stop, or nothing, to end it.` The command prints
  the question and exits 3 with the status `waiting`. Continue with `workflows resume <run-id> --answer <text>`.
- When the answer is `stop`, in any case, or empty, the command prints `stopped <subject> at item <n>: <worktree>`,
  with the path of the campaign's worktree,
  then the rundown, then the lesson lines, and exits 1. The branch keeps its name `campaign/<run-id>`, or `--branch`.
- Any other answer goes back to the step `split`: a new planner session with the `split` prompt and the inputs
  `goal`, `shipped`, `rundown` (the whole question summary) and `answer`. Its items replace the remaining items on the
  same branch, and the next item has the next item number. A later failure asks again. The campaign ends as a campaign
  with no failed item.

`<subject>` is the first non-empty line of the goal without leading `#`. `<n>` in the `done` line counts the shipped
items. The number of the item step counts every item that ran. The result is
`{ "status": "done", "subject", "head", "judge": { "score", "findings" }, "branch", "items": [{ "item", "result" }], "lessons" }`,
with `judgeError` in place of `judge` when the campaign judge failed, or `{ "status": "stopped", "items", "rundown", "lessons" }`. The `result` of
each shipped item, and of the failed item in a stopped result, is its `ship` result, with its `divergence` and its child run ID as
`runId`, and after a fix round that shipped it, the `head`, `score`, `answers` and `findings` of the fix round. `head` is the commit of the last item, and `branch` is the
branch that the worktree ends on.

## Optimize

```sh
workflows optimize ship
workflows optimize ship --limit 4
workflows optimize ship --runs <run-id>,<run-id>
workflows optimize --workflow ship --items items/
workflows optimize ship --always-on-max 2000
```

`workflows optimize ship` proposes one overlay of edits to the ship prompts, agent profiles, skills and `AGENTS.md`,
ships each work item again with it, and keeps it when a blind judge prefers its diffs. It never changes `prompts/`,
`agents/`, the skills or `AGENTS.md`: the result is a diff to apply by hand. It is the package script `workflows/scripts/optimize.js`. The workflow to optimize,
`ship`, is one argument or `--workflow`, and defaults to `ship`.

The work items and their baselines come from one of two places:

- By default, from past runs: `pastRuns("ship", ...)` gives the completed root ship runs of the project store, the
  newest `--limit` (default 8), or with `--runs` the run IDs of that comma list, in that order. A saved run keeps its
  result as its baseline when its status is `shipped` and its `head` is still a commit of its repository; its diff is
  `git diff <start> <head>`. Any other saved run runs its baseline again once, as the child run
  `run("ship", { item, repo: repository, base: start, from: runId })`, with its saved prompts and profiles.
- With `--items <folder>`, relative to the current directory, from `<name>.md` files. Each file has the frontmatter
  `repo`, the path of a local Git repository, relative to the items folder unless it is absolute, and `start`, the
  commit that ship starts from. Quotes around a value are removed. The body is the work item. Each baseline is the
  child run `run("ship", { item, repo, base: start })`.

```text
---
repo: ../calibre
start: "4dfb5c8"
---
# Fix the README typo

The README says wrold.
```

A workflow other than `ship`, `--items` together with `--runs`, no completed ship run, an empty folder, an item
without `repo` or `start`, or a run of `--runs` that is not a completed ship run fails the run after `run <run-id>`,
with `failed optimize: <error>`, and exits 1, because the script checks them when it runs.

The texts that the run can edit are the baseline texts by path: `prompts/<name>.md` and `agents/<name>.md` of the
saved bundle of the first past run, or with `--items` the `prompts/<name>.md` templates and the `agents/<name>.md`
profiles of the run's bundle (so `--prompts <folder>` sets the templates), from `prompts` and `agents`. `inv`, `dom`, `compose` and `select` are not
among them. One turn of the `inv` prompt, in a new session with the `default` agent profile, gets the texts and the
traces of the baselines as JSON: for each one its run ID, the work item, `status`, `rounds`, `findings`, `divergence`,
`lessons`, and `notes`, the notes of its run memory from the `memory` field of its result. It answers
`{ edits: [{ path, text, moment }] }`: `text` is the new text of `path`, or null to remove it, and `moment` names the
run and the finding or note that the edit answers. No edit, a path that is not one of the texts (this includes a path
outside `prompts/` and `agents/`), or a path twice fails the run.

The surface texts come from the repository and the start commit of the first item: `AGENTS.md` at the start, when it
exists, each `.agents/skills/<name>/SKILL.md` and `.pi/skills/<name>/SKILL.md` at the start, and each
`<root>/<name>/SKILL.md` file of the user skill folders, the roots `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills` and
`~/.agents/skills`. One turn of the `dom` prompt, in a new session with the `default` agent profile, gets the surface
texts, the same traces and the roots as JSON, and answers edits in the same shape; no edit is allowed. A path that is
not `AGENTS.md`, a project skill path or `<root>/<name>/SKILL.md` fails the run with
`dom edit <path> is not a skill or AGENTS.md path`, and a path that is also an `inv` or `dom` edit path fails it with
`dom edit <path> comes twice`.

One turn of the `compose` prompt, in a new session with the `default` agent profile, gets the `inv` and `dom` edits,
each with its `source`, and the baseline text of each edited path, or null for a new one, as JSON. It answers
`{ overlay: [{ path, text }], notes: [{ verdict, edit, moment }] }`, where `verdict` is `kept`, `revised` or
`dropped` and `edit` is the path of an edit. An overlay path that is not an edit path, or a path twice, fails the
run. The overlay is the candidate overlay. Each note is the line `<verdict> -> <edit> -> <moment>`.

The candidate is not valid, with one reason line for each problem, in overlay order:

- `invalid candidate: the overlay has no entry`.
- `invalid candidate: <path> has no name` or `... has no description`: a skill text whose frontmatter has no
  non-empty `name:` or `description:`.
- `invalid candidate: <path> removes the skill <name> that AGENTS.md names`: a skill path set to null, whose
  directory name `<name>` occurs in the `AGENTS.md` of the overlay, or else of the start, between characters that
  are not letters, digits, `_` or `-`.
- `invalid candidate: AGENTS.md has <n> characters, over the <cap> cap`: an `AGENTS.md` text longer than
  `--always-on-max`, or else the length of the `AGENTS.md` at the start, or else 0. A last newline does not count.

A candidate that is not valid ships no item and has no `select` turn: it has 0 wins and is not promoted, and the run
still exits 0.

Each item of a valid candidate then ships with the overlay:
`run("ship", { item, repo, base: start, overlay, from: runId })`, where `runId` is the past run, also when its
baseline ran again; an `--items` item has no `from`. So the overlay is the only difference with the baseline. The diff of each ship child run that optimize starts is
`git diff <start> HEAD` in its worktree. Then its worktree and its branch are removed: the `worktree` of its result,
and the `branch` of its result, or else the branch that the worktree is on, read with `git branch --show-current`. When
the worktree removal fails, the worktree and the branch stay, and the report gets the line
`kept <worktree> on <branch>: <error>` before the last line. When only the branch removal fails, the branch stays, and
the report gets the line `kept branch <branch>: <error>` before the last line. Its run directory stays. The worktrees and
branches of the past runs stay.

For each item, one turn of the `select` prompt with the `judge` agent profile gets only the work item and the two
diffs, as `A` and `B`; an empty diff is `(no change)`. It never gets the overlay, the notes or the traces. The
candidate is `A` when the FNV-1a hash of `<name>\n<item>` is even, where `<name>` is the saved run ID, or the item
file name without `.md` with `--items`. So two runs over the same saved runs or the same folder show the same order,
also when a baseline runs again. The turn answers `A`, `B` or `tie`. A candidate win counts 1, a tie or a loss 0. The overlay is
promoted when there are at least 4 items and `wins / items >= 0.75`.

The command prints `run <run-id>`, the note lines, then one line `<name>: win|loss|tie` for each item (`<name>` is
the run ID of the past run, or the file name without `.md`) or the reason lines of a candidate that is not valid,
`fewer than 4 items: nothing promoted` with fewer than 4 items, then
`optimized ship: <wins>/<items> wins, promoted|not promoted, <path>`, then the lesson lines, and exits 0. `<path>` is `overlay.diff` in the
run directory. That file starts with the item lines, the reason lines and one line `edit <path>: <moment>` for each
`inv` and `dom` edit, then `git diff --no-index --no-prefix baseline best` of the run directory. `notes.txt` holds the
note lines. `baseline/<path>` holds the baseline text of each overlay path that has one (none for a new skill), and
`best/<path>` the promoted text (none for a removed one), or the baseline text when the overlay is not promoted, so
then the diff part is empty. An absolute path goes there without its leading `/`. The result is
`{ wins, items, promoted, overlay, notes, invalid, diff, lessons }`, where `overlay` is the candidate overlay, promoted or not,
`notes` the note lines and `invalid` the reason lines.

The run opens its own run memory. After the verdict of each item, it adds the row
`item <subject>: files <paths>, verdict win|loss|tie, confounded yes|no`, where `<subject>` is the first line of the
work item, `<paths>` the overlay paths, joined with `, `, and `confounded` is `yes` when the overlay has more than one
path. The run ends with `.finish(<the description of optimize>, result)`, the harvest of [`ship`](#ship),
which gives `lessons` and one report line for each lesson. When the overlay has more than one path, no rollout tells
which change made a verdict: the run makes no harvest turn and `lessons` is `[]`. A candidate that is not valid has no
row, so its `lessons` is `[]` with no turn.

A ship child run that fails stops the optimization with `failed optimize: child run <id> failed: <error>`, as any
failed `run()` call does. `workflows resume <run-id>` runs the script again: `pastRuns`, the finished ship runs and the
turns and the `memo` calls of the run memory return their saved results, and the failed ship run continues. `workflows list` shows only the optimize run.

## Sessions

The research, plan, implement, review and judge sessions use the agent profiles `agents/researcher.md`,
`agents/planner.md`, `agents/implementer.md`, `agents/reviewer.md` and `agents/judge.md`. Each uses
`anthropic/claude-opus-5-5` with thinking `medium`. The `summarizer` sessions, which compress the notes of the run
memory, use `agents/summarizer.md`, with thinking `low` and the model of the project agent. Every session gets the
same tools. Their instructions say that
the session is not the user's main agent and does not write to the user's memory or note tools, because the run keeps
its own memory. Like every workflow script, `ship` and `campaign` read the scripts, prompts and profiles of the package
and of the project folder `.workflows/` of the current directory, also when `--repo` selects another repository. See
[Workflow scripts](#workflow-scripts). A project `agents/planner.md`, for example, gives the planner another model.

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
workflows audit --path src
workflows ship --help
workflows ./fix.js "Fix the README typo"
cat fix.js | workflows - --json
workflows check audit
```

`workflows <wf>` runs one workflow script. The first word selects it:

- `-` reads the script from stdin.
- A word that ends in `.js` or contains `/` is a file, relative to the current directory. A missing file is an
  error.
- Any other word is a name: `<wf>.js` in `workflows/` of the project folder first, then of the package. A project
  script replaces a package script of the same name. An unknown name fails with `workflows: unknown command <name>`
  and exits 2.

`resume`, `wait`, `stop`, `list`, `show`, `attach`, `save`, `prune` and `check` are commands, so no script of these
names can run. Bad usage of a command prints `workflows: <error>`, then `usage:` and the usage line of that command,
such as `usage: workflows show <run-id> [--pick | [--calls | --agents] [--json]]`, and exits 2.

`workflows --version` prints the version of the package, from its `package.json`, and exits 0. It ignores any other
argument.

The project folder is `.workflows/` at the root of the current directory's Git repository, or in the current
directory outside a repository. It has the shape of the script side of the package, `workflows/` of the package: it
can hold `scripts/*.js`, `prompts/*.md` and `agents/*.md`. A project file adds to the package files, and replaces
the package file of the same name in the same folder. Only the package has `lib/`.

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
    argument that is not `required` and has no `default` and no value is not in `args` when stdin is missing or
    blank, as the empty stdin that the `workflow` tool pipes.
  - At most one argument is `positional`. It also works as `--<name>`; giving it both ways is bad usage. Two
    positional values fail with `give the <label> as one argument`.
  - A `required` argument without a value fails with `missing <label>`. `label` defaults to the argument name.
- `worktree: true` adds `--repo` and `--base`, with the rules of [Ship](#ship), and `--branch`. The run gets a new
  worktree on the branch `--branch` or `<wf>/<run-id>`, runs the script there, and gives it `args.start`, the
  start commit. When another worktree of the repository has the branch checked out, the run fails with `branch <branch>
  is checked out at <path>` before Herdr or Git makes anything. The worktree is `<parent>/.worktrees/<name>/<run-id>`, where `<parent>` is the folder that holds the
  repository and `<name>` is the repository folder's name: `~/code/app` gets `~/code/.worktrees/app/<run-id>`, and the
  clone of a GitHub repository gets `<run-directory>/.worktrees/repository/<run-id>`. When the command ran with
  `HERDR_ENV` set, the run first runs `herdr worktree create --cwd <repository> --path <worktree> --branch <branch>
  --base <start> --no-focus`, so the worktree shows in Herdr. When `herdr` fails, is missing, or makes no worktree at
  that path, Git creates the worktree, as without Herdr. When `herdr` printed a workspace ID but made no worktree at
  that path, the run first closes that workspace with `herdr workspace close <id>`; when that fails, the run fails with
  `herdr workspace close <id> failed: <error>`. A child run uses Herdr when its root run does. When
  `herdr worktree create` made the worktree of a root run and printed the workspace ID that it opened, in
  `result.workspace.workspace_id`, the run types the pick loop in that workspace: see [Herdr](#herdr). At the end, the
  run names the branch: see [Branch name](#branch-name).
- `exit` maps `result.status` to the exit code. A script declares each status that it returns, also the ones that exit
  0. A status that `exit` does not declare exits 1, and a result without `status` exits 0. The status `waiting` always
  exits 3, whatever `exit` says. See [Input](#input).

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

### Branch name

A run with a worktree of its own whose result has a string `subject` names its branch: a shipped `ship` returns the
commit subject, and a done `campaign` the subject of the last split. A child run without a worktree of its own, such
as each item of a campaign, names no branch. The name is `subject` as a branch name: the Conventional Commit type,
`/`, then the lowercase words of the description joined with `-`, at most 48 characters cut at a word end. A subject
without a type gives the words alone. `feat(pi): Show the runs` gives `feat/show-the-runs`, and `Fix the README typo`
gives `fix-the-readme-typo`. A subject without a letter or digit keeps `<wf>/<run-id>`.

The run renames `<wf>/<run-id>` to the name, and adds `-2`, `-3` and so on when the name exists. It renames only when
the worktree is on `<wf>/<run-id>`, so a repeat after the rename keeps the branch it renamed to, and a run on a
`--branch` branch keeps it. The result gets `branch`, the branch that the worktree ends on, and the report gets the
last line `branch <branch>`. A name that Git refuses, such as `docs/typo` when a branch `docs` exists, keeps
`<wf>/<run-id>`, and the last line is `branch <name> is in conflict with an existing branch; kept <wf>/<run-id>`.
A branch `<name>` that another process creates while the run renames keeps `<wf>/<run-id>`, with the last line `branch
<name> was created during the rename; kept <wf>/<run-id>`. A worktree on a detached HEAD keeps `<wf>/<run-id>` in
`branch`, with the last line `the worktree is on a detached HEAD; kept <wf>/<run-id>`.

`--branch <name>` puts the worktree on the new branch `<name>` in place of `<wf>/<run-id>`, from the start of the run.
A value that is not a valid branch name fails before the run starts with `--branch <name> is not a valid branch name`,
and a branch that exists with `--branch <name> exists`.

### Output

The command prints `run <run-id>` on stdout, then each `phase` and `log` line on stderr when the script's next call
runs, or when the script ends. The script runs in the host, which saves these lines in the project store, and the
command reads them from the store file about every 0.5 s. A read that fails prints `warning: cannot read the progress
of run <run-id>: <error>` on stderr once for each series of failed reads, also with `--json`; the next good read prints
the lines that it missed. See [Progress](#progress). When the script returns a result with `report`, a list of lines, the command prints
those lines on stdout. Otherwise it prints the return value: a string as it is, and any other value as JSON. The exit
code comes from `meta.exit`. A run that waits for an answer to `input(question)` prints the question and exits 3. When
stdin and stderr are terminals, and without `--json` or `--background`, the command asks the question in place of the
exit: it reads one line on the terminal and continues the run with it as the answer. See [Input](#input). With
`--json`, stdout gets one JSON outcome line in place of the lines. See [JSON output](#json-output).

A script that throws, or a call in it that fails, stops the run: the command prints `failed <title>: <error>` and
`continue with: workflows resume <run-id>` on stderr, and exits 1.

### Progress

The `phase` and `log` lines of a run make a tree of steps. Each `phase` line is a step of its run, and the step before
it in the same run is done. Each `log` line is under the current step of its run, or at the level of its run before
the first step. A child run is under the step of its caller that is current when it starts, indented by 2, also when
it has no line of its own. When the caller has no step then, the child run moves under the caller's next step. The
command draws the tree on stderr in one of three ways:

- On a terminal, the command draws the tree again in place at each change. A step is `◉` while it runs, `✓` when it
  is done, `✗` when its run failed, and `·` when its run was stopped. A step that ended ends with two spaces and its duration, such
  as `12s`, `3m05s` or `1h02m`, from its `phase` line to the next `phase` line of its run or the end of its run. Each
  line is cut to the columns of the terminal. When another
  line, such as a warning, comes between two draws, the lines above it stay, and the changed lines print again below
  it.
- When stderr is not a terminal, and without `--json`, each step and log line prints once as it comes, with its indent
  and without a mark.
- With `--json`, each change prints one stderr line `{"progress":["<line>",...],"status":"<status>"}` with every
  line of the tree, each step as `<indent><mark> <text>`, with the duration of a step that ended as on a terminal,
  and each log line as `<indent><text>`, and the status of the run, without `status` when no step runs. A run without
  steps prints no progress line.
  The [Pi tool](#the-workflow-tool) draws the last of these lines, so Pi shows the same steps as a terminal.

The store keeps each line with its time; lines that an earlier version saved have none, and show no duration. The
first `phase` line of an execution of a run, such as after a resume, continues the step of the same text that runs,
without the time between, and prints nothing. Any other `phase` line starts a new step.

The status of the run is the text of each step that runs, outermost first, joined with ` › `, such as
`item 2/5: Add a thanks line › round 1/3: review`; child runs that run at once join with `, `. Only the `--json` line,
the [Pi widget](#background-runs-in-pi) and `list --pick` show it.

When the run ends, the steps that still run become `✓` when the run finished or waits for an answer, `·` when it was
stopped, and `✗` when it failed in another way. The end of a stopped run is saved with `stopped`, so `show` and a later
command show its steps as `·` too. A command that Ctrl+C detaches leaves them as they are. On a terminal and with `--json`, the tree draws once
more then. A command that follows a run shows only the lines that come after it starts or reaches the run. `<title>`
is the subject of the first `text` argument, or else the file name without `.js`, the workflow name, or `stdin`. The
run's task ends as failed, and its saved calls stay in the project store for the resume. `workflows show <run-id> --calls` shows the failed call. See [Show](#show).

`workflows/scripts/ship.js` stops with an error when it gets no `start` argument: `ship runs only through workflows ship or
workflows campaign, which give it the start commit`. `run("ship", { repo })` gets its own worktree and `start`, as
`workflows ship` does. `run("ship")` without `repo` runs in the caller's directory and needs `start` from the caller.
The script does not check where `start` comes from: with `start` from another script, it runs in that script's
directory and can commit there.

#### Program status

When stderr is a terminal, a command that follows a run also writes OSC 7501 program status reports to stderr:
`ESC ]7501;state=<state>:app=workflows:msg=<base64 of the message> ESC \`, or
`ESC ]7501;state=blocked:kind=question:app=workflows:msg=<base64 of the message> ESC \` for a question. `working` comes at each `phase` line, also
of a child run, with the phase text. `idle` comes at the `detached` line, with that line. `done` or `error` comes when
the command reports the outcome, by its exit code, with the first line that it prints, which can be empty. When the
command asks the question of a waiting run, `blocked` with the kind `question` comes in place of `done` or `error`,
with the question. `idle` comes with the `waits for an answer` line when no answer comes. With
`--json` or `--background`, or when stderr is not a terminal, no report comes. In the message, each control character
becomes a space, and the message is cut to 2048 UTF-8 bytes on a character boundary.

### Child runs

`run(name, args)` starts a child run of the script `name` of the caller's saved scripts. The child run has its own run
ID and run directory, but no `project` file: it is a child task of the caller's task. So `workflows list` does not show
it, and `workflows resume <child-id>` prints `workflows: no run <child-id> in <runs>`. A resume of the caller
continues it. It runs in the same host, and its `phase` and `log` lines go to the same stderr, under the caller's
current step: see [Progress](#progress). It prints no `run` or report line. Its sessions belong to the child run, and
its end ends them as the end of a run does: see [Runs in the harness host](#runs-in-the-harness-host).

- The child's args are the defaults of its `meta.args`, then `args`, without `prompts`, `overlay`, `from` and `checkout`, and with `meta.worktree` also
  without `repo`, `base` and `branch`. Before any worktree or child task exists, the declared args are checked against
  `meta.args` in declaration order, and the first problem fails the call with `run <name>: <arg> <problem>`: a
  `required` arg without a value `is missing`, and a value of the wrong type (`null` included) `must be a positive
  integer`, `must be a string` or `must be a boolean`. A `boolean` that is not given gets no `false`. An undeclared
  arg is not checked and reaches the script.
- With `meta.worktree` and `args.repo`, the child gets a new worktree on `<name>/<child-id>`, next to the repository as
  for `meta.worktree`, in
  the repository of `args.repo` from the caller's directory, at `args.base` (default `main`), and `args.start`.
  `args.branch` works as `--branch`. Without `args.repo`, or without `meta.worktree`, the child runs in the caller's
  directory, and `start` is an ordinary arg.
  With `meta.worktree`, a `repo`, `base`, `branch` or `start` that is not a string fails the call with
  `run <name>: <key> must be a string`.
- Without `meta.worktree`, `args.checkout` names an existing branch of the repository of the caller's directory. It is
  not an arg: the child runs in a new worktree on that branch, next to the repository as for `meta.worktree`, and
  `start` stays an ordinary arg. `checkout` needs `start`, the commit that the change on the branch starts from: a
  `start` that is not a string fails the call with `run <name>: checkout needs start as a string`. A branch that does
  not exist fails the call with `run <name>: no branch <branch>`, and `checkout` fails the call for a script with
  `meta.worktree`. `checkout` is a reserved argument name.
- `args.prompts` maps prompt names to template texts. Each text, without frontmatter and the last `$@`, replaces that
  prompt in the child run only. A name with no prompt fails the call.
- `args.overlay` maps paths to texts or `null`. A value of another shape fails the call with
  `run <name>: overlay is not an object of path to text or null`. `overlay` is a reserved argument name.
  - A key `prompts/<prompt>.md` replaces that prompt, as `args.prompts` does, or removes it with `null`. A key
    `agents/<profile>.md` replaces that agent profile, parsed as a file of `agents/`, or removes it with `null`. A key
    for a name that the caller's bundle does not have fails the call with `run <name>: no prompt <prompt>` or
    `run <name>: no agent profile <profile>`. A call of a removed prompt or profile fails as a call of an unknown name
    does. When `args.prompts` and `args.overlay` replace the same prompt, the text of `overlay` wins.
  - Every other key is a file that the sessions of the child run see in place of the disk: the run opens each session
    with these files as `overlay` in its spec of the children library, so the subagents of the session see them too.
    A string replaces the file, and `null` removes it. A relative key is relative to the session's directory, the
    run's worktree; an absolute key stays as it is. The files on disk do not change. The child run saves the files
    as `overlay` in its input, over the files of the caller run: the caller's keys are inherited, and the child's own
    keys win. Keys compare as written, so a relative key and the same file as an absolute key are two keys.
  - A run without files in its overlay saves no `overlay` field, and its sessions open with no overlay.
- `args.from` names a saved root run of the project store, of any workflow and any status. The child run gets the
  prompts and profiles of that run's saved bundle in place of the caller's; the scripts and the lib stay the
  caller's. `args.prompts` and `args.overlay` apply on top of them. A run ID that is not a root run of the store, such
  as a child run ID, fails the call with `run <name>: no run <id>`, and a `from` that is not a string fails it with
  `run <name>: from is not a run ID`. `from` is a reserved argument name.
- The child run gets the caller's saved scripts, prompts and profiles, or those of `args.from`, with the replacements
  of `args.prompts` and `args.overlay`, and the caller's file overlay. So every child run of a child run gets them too.

`run()` returns the child's result, with `runId`, the child run ID, added to an object result. A failed child run
fails the call with `child run <id> failed: <error>`, where `<id>` is the deepest child run that failed, and the child's task ends as failed. A child run that was stopped (aborted or orphaned) fails the call with `child run <id> stopped: <reason>`. A caller that fails aborts
its child runs that are still running. A resume of the caller continues the same child run, with the same run ID and
run directory, also after a failed call, an abort or an interruption, and repeats no call that the child run saved. A
child run that ended without a result continues in a new task.

### The script API

A script is the body of an async function: top-level `await` and `return` work. Each call below is a durable call,
except `phase`, `log`, `args`, `cwd`, `prompts` and `agents`.

| Global | Meaning |
|---|---|
| `args` | The argument values of `meta.args`, and `start` with `worktree: true` |
| `runId`, `runDir` | The run ID and the run directory. A script that `run()` starts gets its own values |
| `cwd` | The directory where `sh` and `ok` run: the run's worktree, the caller's directory, or the directory of the command |
| `agent(prompt, { as, provider, model, thinking, schema })` | One turn in a new session of profile `as` (default `default`), with the model of [Agent profiles](#agent-profiles). Returns the reply text, or the answer with `schema` |
| `session(profile)`, `session({ as, provider, model, thinking })` | A new session of the profile (default `default`), with the model of [Agent profiles](#agent-profiles). `.ask(prompt, { schema })` is one turn in it |
| `sh(cmd)` | Runs `sh -c <cmd>` in the current directory of the start. Returns stdout without the last newline, and throws on a nonzero exit code. With an array `[program, ...arguments]`, runs the program with no shell, and the error is `<program> <first argument> failed: <output>` |
| `ok(cmd)` | Runs `cmd` as `sh` does. Returns true when the exit code is 0 |
| `run(name, args)` | Runs the script `name` of `scripts/` in the package or the project as a child run and returns its result. See [Child runs](#child-runs) |
| `pastRuns(workflow, { runs, limit })` | The completed root runs of `workflow` in the project store. See [Past runs](#past-runs) |
| `input(question)` | Asks the user `question`, and returns the answer of `workflows resume <run-id> --answer <text>`, or of the `workflow` tool with `resume` and `answer`. See [Input](#input) |
| `prompts.<name>(inputs)` | The instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section |
| `agents.<name>` | The text of `agents/<name>.md` that gives the profile of the run's bundle: its `model` and `thinking` frontmatter, then its body. Other frontmatter fields are not in it |
| `phase(title)`, `log(text)` | Write one step, or one line under the current step, on stderr before the script's next call that runs |
| `title(text)` | Name the run `text` in `list`, `show` and the end lines, in place of the subject of its first `text` argument; the last call wins. `changeOf` calls it with the subject of the intent |

A call with an argument of the wrong type, such as a prompt that is not a string, a `sh` command that is not a string
or an array of strings, or a `prompts.<name>` input that is not a string, fails with
`<call> got bad arguments: <path> <problem>`, where `<call>` is `session`, `ask`, `sh`, `ok`, `run`, `pastRuns`, `input` or `prompt`, and
`<path>` points to the deepest wrong value in the arguments, such as `/0/1` for `sh(["git", 1])`.

#### Past runs

`pastRuns(workflow, { runs, limit })` returns the root runs of the script `workflow` in the project store whose last
task completed with a result that does not wait for an answer, newest first by run ID. Child runs, waiting runs and
runs in progress are not in the list. It reads the tasks of
`workflows.run` through the host, at the current task version and at earlier ones, and skips a task whose saved input
does not have the fields below. Each run is an object:

| Field | Value |
|---|---|
| `runId` | The run ID |
| `item` | The `item` arg of the run, or `null` |
| `repository`, `start` | The repository and the start commit of the run's worktree, or `null` |
| `prompts` | The saved template texts, by prompt name |
| `agents` | The text of `agents/<name>.md` that gives each saved profile: its `model` and `thinking` frontmatter, then its instructions |
| `result` | The result of the run |

`runs`, an array of run IDs, gives those runs in that order: an ID that is not a completed root run of `workflow` fails
the call with `no completed <workflow> run <id>`. Without `runs`, `limit`, an integer of 0 or more, gives at most that
many runs; without `limit`, it gives all of them. Another option fails with `pastRuns got bad arguments`. The call
saves its result, so a resume returns the same list and does not read the store again.

#### The script lib

Every script also gets these helpers of the files of `workflows/lib/`, which the run puts after the calls above. They
use only the calls above. A lib file only declares: it runs no code when it loads, so the order of the files does not
change the result. A run saves the lib with its scripts and prompts, so a resume uses the lib that the run started
with. A script's own declaration of the same name takes their place.

| Global | Meaning |
|---|---|
| `parallel(thunks)` | Runs the functions at once and returns their results |
| `pipeline(items, ...stages)` | Sends each item through the stages in order, and the items at once |
| `subjectOf(text)` | The first non-empty line of `text`, without leading `#` |
| `oneLine(text)` | `text` with each whitespace run made one space, trimmed |
| `await memory(ref)` | The run memory of `ref`, `{ path, plain, item }`: the OptMem store `path`, through `$HOME/.optmem/memo` with `MEMORY_DIR` set to `path`, or with `plain` the file `<path>/notes.txt` of `#<k> <note>` lines, with no summaries, and `<path>/notes.keys`, the key `<run-id>/<n>` of each note, whose line is `<k>`. Without `ref.path`, opens the store `<runDir>/memory` with `memo init` and `memo config PART_CHARS=100000`, or, without `memo`, the plain store, and logs the install command of OptMem. `.ref` goes to a child run. `.note(author, round, notes)` adds each note, as the line `[item <item> ]<author>[ r<round>]: <note>`, with its whitespace collapsed, empty ones left out, and words cut from its end above 280 UTF-8 bytes, then, in an OptMem store, answers each compression that `memo` asks for with a `summarizer` turn and `memo nap`. A compression request without `nap <a>-<b>` fails with `memo asked for a compression without "nap <a>-<b>": <first line>`, and the 65th request in a row fails with `memo still asks for compressions after 64 summaries`. `.text` is a promise of the notes, one `#<k> <note>` line each. `.finish(item, result)` gives `result` as it is when `ref.path` was given, else `result` with `lessons` and the report line `  lesson <cue>: <lesson> (<evidence>)` for each lesson after the other lines: `[]` with no turn when there are no notes, else the lessons of one `summarizer` turn on the `harvest` prompt with `item` and `result` without its `report` and `memory` keys at any depth, each `{ cue, lesson, evidence }` with its whitespace runs made one space. `.session(profile)` is a session whose first `.ask(prompt, { schema })` starts with a `## memory` section of the notes, from `memo wake` in an OptMem store, and whose `.noted(round, prompt, rule)` adds `When you are done, answer with respond: text is <rule> Each note is one line of at most 280 bytes.`, asks for `{ text, notes }`, adds the notes under the profile, and returns the text |
| `await noteLines(notes)` | The `#<k> <note>` lines of `notes.text`, without empty lines |
| `commitAll(message)` | Stages every change, and commits it as `message` when something is staged |
| `writePatch(path, from)` | Writes `git diff --binary` from `from` to `HEAD` to the file `path`, and returns `path` |
| `diffStat(from, to)` | `+<insertions> -<deletions> in <n> file(s)` for `git diff from to` (`to` defaults to `HEAD`), or `no new changes` |
| `assertClean()` | Throws `the checkout has changes that are not committed; commit or stash them first` when `git status --porcelain` shows a change |
| `changeOf(args, { wip })` | `{ start, intent, checkout, dirty }` of the change of a script's `args`. With `args.start`, it is `args.start` and `args.item`, not dirty, with no Git step. Else it is the change that `args.change` points at from `args.base`, with the rules of [Thermoloop](#thermoloop), and it calls `title` with the subject of the intent: `start` is the start commit, `intent` is `args.item` or the pull request or the commit messages, `checkout` is the branch of a change that must run in a worktree of its own, and `dirty` says that the checkout has changes that are not committed. With `wip`, a change in the current checkout commits them first as `wip` |
| `inCheckout(name, change, args)` | Runs the script `name` again as a child run with `args`, the `item` and `start` of the change, and `checkout`, the branch of the change, and returns its result with the last report line `worktree <path>`, the worktree that has the branch |

`workflows/script.d.ts` declares these globals for editors. A project gets the same completion when it copies
`script.d.ts` and `jsconfig.json` into `.workflows/`, and copies them again after an upgrade of the package.

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

Before the run starts, it saves the script, every `scripts/*.js` of the package and the project, the lib, the instructions
of every prompt, every profile, the args and the current directory. Resume and `run()` use these saved inputs, so a
later edit of a script, prompt or profile, in the package or in `.workflows/`, changes only new runs.

Resume runs the script again from the top. A call that succeeded before returns its saved result, and is not run
again. A call is known by its name, its arguments and its position among identical calls. A turn that was in progress
continues in its session. A command that was in progress runs again, so commands must be safe to repeat. Each call
records its kind, arguments, phase and start time when it starts, and its end time with its result or its error when
it ends. It also records the task that started it, and for a `run` call the run ID of its child run before the
child's run directory exists, so a rerun after a crash uses the same run ID and directory. A call that fails saves no
result, so every call that failed runs again, also one that the script caught. The
saved results stay in the project store also after the run fails. `phase` and `log` lines are progress, not saved
results. A resume prints the phase line of the first call that runs, and the lines after it. A call that returns a saved result drops the `log`
lines before it, and keeps the last `phase` line waiting for the next call that runs.

An `input` call with an answer saves the answer as its result, so a later resume returns it, and does not wait again.

When the script ends, by its result or by an error, the calls that it did not wait for are cancelled: a `sh` or `ok`
command is killed, a `run()` call stops waiting for its child run, and an ask stops waiting for its turn. The script's
task ends only once they stopped, so no call goes on after the run ended. A cancelled call records no end, and runs
again on resume. It records the time of the cancel, so `show` shows it as `cancelled`; a call that a stop or a host
stop cut records nothing more.

### Input

`input(question)` asks the user a question. The first time the script reaches it, the call records its start, the
script stops, and the run's task completes with the result `{ "status": "waiting", "question", "report": [question] }`.
The command prints the question as the report line and exits 3, also with `wait` and with a resume without
`--answer`, when it cannot ask. A command can ask when stdin and stderr are terminals, without `--json` or
`--background`, and not after a Ctrl+C; `wait` never asks. Then the command reads one line on the terminal, with its
echo on stderr, and continues as `workflows resume <run-id> --answer <line>` does: it prints `run <run-id>` again and
follows the new task. A later `input` call asks again in the same way. Ctrl+C or the end of input while the command
reads prints `run <run-id> waits for an answer; continue with: workflows resume <run-id> --answer <text>` on stderr
and exits 130, and the run still waits. `list` and `show` give the status `waiting`, and `show` lists the `input` call as `✗`, with the question
as its label and the word `waiting`. A waiting run keeps its sessions, as a failed run does.

`workflows resume <run-id> --answer <text>` starts a new task of the run with the answer to the open `input` call: the
last one that started and did not end. The script runs again from the top, and that call returns `<text>`. A later
`input` call waits again in the same way. While one `input` call waits, a second one that would wait fails the run with
`the run waits for an answer to: <question>`, the question of the first; the script cannot catch it. A run without an open `input` call fails with `workflows: run <run-id> has no
open input call` and exits 1. When the script returns or waits again without the `input` call of the answer, such as
after a call that failed before now succeeds, the run fails with `resume --answer answered "<question>", which the run
did not ask`. A resume without `--answer` drops the answer of the last task: a call that used it returns it from its
record, and the run asks again a question that it did not reach. A script that returns `{ "status": "waiting" }`
itself also exits 3.

`input()` in a child run has no special handling: the caller of `run()` gets the waiting result as the result of the
child run.

## Resume

```sh
workflows resume <run-id> [--answer <text>]
```

`workflows resume` finds the workflow that the run saved and continues the run. A run that is gone, with no run
directory or no task, prints `workflows: no run <run-id> in <runs>` or `workflows: run <run-id> has no workflow`, and
exits 4. Every command that reads a saved run (`resume`, `wait`, `stop`, `show`, `save` and `attach`) does the same. A run of a workflow script continues
with the script that the run saved. The `project` file of the run directory names the run's project, so resume reaches
the host of that project from any directory.

Resume continues the pending work in the host. For a script, see [Saved inputs and resume](#saved-inputs-and-resume).
For `ship`, it uses the work item, repository, start commit, `workflows/scripts/ship.js`, prompts, profiles and round limit
that the run saved before it started. `campaign` does the same with its goal and `workflows/scripts/campaign.js`: the split,
the splits, the shipped items and the rundown are not run again. It does not read the work item file again, select or clone the
repository again, or create another branch. Answered turns are not sent to the model again. A turn that was in
progress is sent again.

With `--background`, at any position before `--`, start and resume print `run <run-id>` once the host has the run's
task, and exit 0 without following it. With `--json`, they also print
`{"runId":"<run-id>","status":"started","workflow":"<workflow>"}`, where `<workflow>` is the name of the run's workflow,
as `workflows show` gives it. A Ctrl+C after the host accepted the task does not change this. The other commands
ignore `--background`. Follow such a run with `workflows wait <run-id>` or `workflows resume <run-id>`. A start with `--background` saves `notify` in the
input of the run. A resume that starts a new task saves `notify` only with `--background`, whatever the last task
had. A resume that follows a task that has not ended does not change it. See
[The `workflow` tool of the host](#the-workflow-tool-of-the-host) for what `notify` does.

A run has one live task at a time. When the run's last task has not ended, because it runs in the host or waits for
the host to start, resume follows that task and prints its outcome. When the host runs, resume prints the progress
lines of the task's current execution from its start. When no host runs, resume starts it and prints the progress
lines that come after. A host that starts continues the unfinished runs of its project on its own. When resume starts
a new task, it prints the progress lines of that task. When two resumes of a run start a new task at the same time,
the first one gets the task. The other follows that task when it sent the same input, else it prints `workflows: run
<run-id> was resumed by another command with another input: follow it with workflows wait <run-id>` and exits 1.

A run that fails with an error prints `failed <subject>: <error>` and `continue with: workflows resume <run-id>`, and
exits 1. Examples are a failing Git hook, or a model error that remains after Pi's retries. The run's task ends as
failed. Resume runs the script again in a new task of the same run, with the same input: a failed Git step runs again,
a failed turn is sent again in the same session, saved calls return their results, and child runs continue. A run whose
task ended in another way, such as a stopped or orphaned task, or one that pi-durable faulted, resumes in the same way. An ask whose answer
stopped for a reason other than its end, such as its length, fails its call, and a resume asks again. So does an ask
whose answer did not call `respond`. A resumed ask never returns the answer of another ask in its session.

A shipped, blocked or stopped run is final: resume prints the same result and exits with the same code. A waiting
run without `--answer` prints its question again and exits 3. When the command can ask, it reads the answer on the
terminal and continues the run with it, or prints the `waits for an answer` line and exits 130 when no answer comes.
`--answer` for a run whose last task did not complete
with the status `waiting` prints `workflows: run <run-id> does not wait for an answer` and `usage: workflows resume
<run-id> [--answer <text>] [--background] [--json]`, and exits 2. See [Input](#input).

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

When the `start` request fails in another way, such as a connection that closes, the command sends the same `start`
again, with the same key and input, on a new connection, and starts the host when none runs. The host creates the task
of a key once, so this gives the task that the first request created, or creates it, and the command follows the run.
When the second request fails too, the command keeps the run directory and prints the first error with `run <run-id>
may have started: workflows resume <run-id>`.

### Ctrl+C and stop

The run goes on in the host after the command ends. Ctrl+C detaches the command: it prints `detached; run <run-id>
goes on. Follow it with: workflows resume <run-id>. Stop it with: workflows stop <run-id>` and waits 2 s for a second
Ctrl+C. Without one, it exits 130, or reports the outcome of a run that ends in those 2 s. A second Ctrl+C in those
2 s stops the run: the run's task ends as stopped, and the command prints `stopped <title>; continue with: workflows
resume <run-id>` and exits 130. A second Ctrl+C that comes before the command waits for it, such as one right after
the first, stops the run in the same way. A second Ctrl+C while the command follows no run, and a third, exit at once.
A Ctrl+C before the run starts, such as while the command clones the repository, starts no run: the command removes
the run directory, prints `workflows: interrupted before the run started` and exits 130.

When the host closes the connection after it replied to the stop of a second Ctrl+C, it has saved the stop, so the
command prints the `stopped` line, or `{"runId","status":"stopped"}` with `--json`, and exits 130. Otherwise, when the
host stops while the command follows the run, the run stays pending: the command prints `the host stopped;
the run continues when it starts again: workflows resume <run-id>`, leaves the steps as they are and exits 1. The next
host continues the run when it starts, and `resume` starts it.

```sh
workflows stop <run-id>
```

`workflows stop` stops a run that runs, from any directory: it aborts the run's task with its child runs, sessions and
Git steps, prints `stopped <title>; continue with: workflows resume <run-id>` and exits 0. It does so also when the host
closes the connection after it replied to the abort, which it saved then. When no host runs, `stop`
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
the same outcome lines, JSON line and exit code as `resume`. A waiting run prints its question and exits 3. A run whose task ended, completed or not, prints its
outcome from the project store: `wait` starts no host and no task, so a failed run prints its `failed` and `continue
with` lines and exits 1. A run whose task has not ended is followed as `resume` follows it, with every step of the run
from its first line, and `wait` starts the host when none runs. `wait` checks the version of the host's task as `resume` does, and refuses a run that another version
saved with `workflows: run <run-id> was saved by an earlier version of <workflow> and cannot be waited for`.

Ctrl+C detaches `wait` at once: it prints the `detached` line, or the `detached` JSON line, and exits 130. The run goes
on in the host. A second Ctrl+C exits and never stops the run. Bad usage prints `usage: workflows wait <run-id>
[--json]` and exits 2.

## Herdr

`workflows` binds no Herdr key. A Herdr key composes the commands instead, such as one that picks a run, then one of
its agents, in a popup, and opens the agent in a new tab:

```toml
[[keys.command]]
key = "prefix+w"
type = "popup"
description = "attach to an agent of a workflows run"
command = '''
id=$(workflows list --pick) && c=$(workflows show "$id" --pick) && workflows attach "$id" --conversation "$c"
'''
```

A popup command does not get `HERDR_PANE_ID`, so `attach` opens the tab in the workspace that has the run's worktree
open, or runs Pi in the popup when no workspace has it open.

When `herdr worktree create` made the worktree of a root run, the run types the pick loop in the first pane of the new
workspace, as `herdr pane list --workspace <id>` lists it, with `herdr pane run <pane> <loop>`:

```sh
while c=$(workflows show <run-id> --pick); do workflows attach <run-id> --conversation "$c" --side; done
```

So the shell of the workspace shows the steps of the run, and each pick opens its agent in a new pane beside the
steps. Escape or Ctrl+C in the pick ends the loop. The loop needs `workflows` on the `PATH` of the shell. A failure of
`herdr pane list` or `herdr pane run` types nothing, and the run goes on. A worktree that Git made gets no loop, and a
resume, which finds the worktree, types nothing again. A child run types nothing.

`prune` and `attach` use Herdr when `HERDR_ENV` is set: see [Prune](#prune) and [Attach](#attach). A run that a
command started with `HERDR_ENV` set asks Herdr to create its worktrees: see [The meta block](#meta).

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
  A run that waits for an answer is `finished` with the result `{"status":"waiting","question":"<question>","report":["<question>"]}`
  and the exit code 3.
- `failed`: `error` is the error message.
- `started`: with `--background`, the host has the run's task, and the command does not follow it. `workflow` is the
  name of the run's workflow. The `workflow` tool of the host and the `workflow` tool of Pi give it as a result that
  is not an error.
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
workflows list --pick
```

`workflows list` prints one line for each run of the harness project of the current directory, newest run ID first:
`<run-id> <workflow> <status> <title>`. Runs of other projects are not listed. `<workflow>` is the script name. Child
runs are not listed: they are tasks of their caller. The title is the last `title(text)` of the run, such as the subject of the intent of
`thermoloop`, else the subject of the first `text` argument, such as the work item for ship and the goal for campaign, or
else the script name. A finished run has the
`status` of its result, such as `shipped`, `blocked` or `stopped` for ship and `done` or `stopped` for campaign, or
`done` when the result has no `status`. A run that waits for an answer to `input()` is `waiting`. A run whose task has not ended is `running`, also when it waits for its host
to start. A run whose task ended without a result is `aborted` (a second Ctrl+C or `workflows stop` stopped it), `failed` (also a task that pi-durable faulted) or `orphaned`. A pending run that
another version of workflows saved is `earlier-version` or `later-version`, with its workflow name as its title: it
cannot resume. With `--json`, the command prints one JSON array of `{ "runId", "workflow", "title", "status", "repository" }`.
`repository` is the path of the Git repository of the run's worktree, as the run saved it, and it is `null` for a run
without a worktree.
Only the runs that have a run directory with a `project` file are listed. The command writes that file before it
prepares the run, so a run directory of the project whose run has no task is listed as `<run-id> - unstarted -`, and
with `--json` as `{ "runId", "workflow": "-", "title": "-", "status": "unstarted", "repository": null }`: its run is
about to start, or its command stopped before the host created the task. `--pick` leaves these out.

With `--pick`, on a terminal, the command asks `Pick a run:` with the runs that run or wait first, each as `<mark>
<title>  <workflow> <status>`, with `: <status of the run>` of [Progress](#progress) for a running run. The mark is `◉` running, `?` waiting,
`✗` failed (a task that ended without a result, not a result whose `status` is `failed`), else `·`. Typing filters by each word, in any case; the arrows move, Enter prints the run ID, and Esc or
Ctrl+C exits 130. So commands compose: `workflows wait "$(workflows list --pick)"`. While the pick waits for a key, the
command reads the runs again 1 s after each read ends and draws the new lines, with the typed filter kept and the cursor
on the same run, else on the first match. A read that fails keeps the lines it has, and a read that finds no run shows
`nothing matches`. A project with no run at the first read exits 1, and `--pick` without a terminal exits 2.

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
`project` file, its last task has ended, a task of this version or of an earlier version saved it, its saved input has a
worktree, the worktree exists, and the worktree is on a branch. For a run of an earlier version, `prune` reads only the
`worktree` of its saved input. A run of a later version, a run without a worktree, a run that has not ended, a detached
worktree, and a worktree that is not a Git worktree of its own are never pruned. `prune` reads the project store file read-only, as `list` does, and does not
start the host.

For each candidate, `prune` runs `gh pr list --head <branch> --state merged --json headRefOid` in the worktree. A branch
is merged when one pull request in the list has the commit that the worktree is on as its head. A branch name that comes
back in a later run, with a merged pull request of an earlier commit, is not merged. `prune` runs every `gh` call before
it removes anything: a failed `gh` call, or a missing `gh`, prints `workflows: <error>`, removes nothing and exits 1.

With `--yes`, `prune` removes each merged worktree in order, and prints its line after the removal. When `HERDR_ENV` is
set and `herdr worktree list --cwd <worktree>` shows a workspace open on the worktree, it runs `herdr worktree remove
--workspace <id>`. Otherwise, or when the herdr command is not installed, it runs `git worktree remove <worktree>` in
the run's repository, without `--force`. A herdr command that fails otherwise fails the removal of the run. Then it deletes the branch with `git branch -D <branch>` when the branch still exists. Before
it removes anything of a run, it writes the marker `runs/<run-id>/pruning`, a JSON object `{ "branch", "repository",
"path" }`, and it deletes the marker when the worktree and the branch are gone. A run with a marker is a candidate with no
other check and no `gh` call, so a `prune` that stopped after the worktree removal is finished by the next one. A removal
that fails, such as of a worktree with changes, prints `workflows: cannot prune <run-id>: <error>` on stderr, leaves the
run out of stdout and the JSON, and goes on with the next run; `prune` then exits 1. A failed worktree removal deletes the
marker, as the worktree can get more work; a failed branch removal keeps it. The run directory and the run's records
stay, so `list` and `show` still show the run.

`prune` also prints one line `<run-id> unstarted <run directory>` for each run directory of the project whose run has
no task (the `unstarted` runs of `list`) and whose `project` file is more than 1 hour old, after the merged runs. With
`--json`, each is an object `{ "runId", "directory" }` in the same array. With `--yes`, after every `gh` call, `prune`
removes these run directories.

`--install-hook` writes the executable `post-merge` hook of the Git repository of the current directory, with the line
`workflows prune --yes >/dev/null 2>&1 &`, and prints the hook's path. When `core.hooksPath` is set or a `post-merge`
hook exists, it writes nothing, prints an error with the line to add, and exits 1. `--install-hook` ignores `--yes` and
`--json`.

## Show

```sh
workflows show <run-id>
workflows show <run-id> --calls
workflows show <run-id> --agents [--json]
workflows show <run-id> --json
workflows show <run-id> --pick
```

`workflows show` prints one run from the store of its project: the line `run <run-id> <workflow> <status> <title>`,
with the fields of `workflows list`, then the steps of [Progress](#progress) from the first line of the run, then the
report lines, or the `failed` and `continue with` lines. Once the run's task ended, the steps that still ran are `✓`
when it completed, `·` when it was stopped, and `✗` otherwise. A run without steps prints its calls, as `--calls` does.

With `--calls`, `show` prints the tree of its phases and calls:

```text
run <run-id> <workflow> <status> <title>
<phase line>
  ✓ <kind> <label>  <duration>
<report lines, or the failed and continue with lines>
```

- The calls are in the order they started. Each call is under the phase line that was current when it started, and is
  indented by 2. A call before the first `phase` has no phase line above it. The kind is `session`, `ask`, `sh`, `ok`,
  `run` or `input`. An `agent` call is a `session` call and an `ask` call.
- Each call has a state. It is `done` or `failed` once it ended. A call that did not end is `cancelled` when the end of
  its script cancelled it, `waiting` when it is the open `input` call of a waiting run, `running` while the task that
  started it has not ended (it runs now, or the host stopped), and `cut` once that task ended. A call that an earlier
  version saved has no task: it is `running` until the run's task ended, and `cut` after.
- The mark is `◉` for `running`, `✓` for `done`, and `✗` for every other state. A `cancelled`, `cut` or `waiting` call
  shows its state in place of its duration. A session is `◉` while one of its asks is `◉`; once the task ended, it
  keeps its `✓` or `✗`.
- The label is `<profile> conversation <id>` for a `session` that opened, with the profile and the conversation ID of
  the session, and the profile only for a `session` that did not open. For `ask`, it is the profile of its session. For
  `sh` and `ok`, it is the command on one line, cut at 80 characters. For `run`, it is the workflow name and the child
  run ID. For `input`, it is the question on one line, cut at 80 characters. The phase lines and calls of the child run
  are indented by 2 more under the `run` line.
- The duration is the time of the call, such as `12s`, `3m05s` or `1h02m`. For `◉`, also for a working session, it is
  the time since the call started.
- A finished run ends with its report lines. A failed run ends with `failed <title>: <error>` and `continue with:
  workflows resume <run-id>`, an aborted run with `stopped <title>; continue with: workflows resume <run-id>`, and an
  orphaned run with `orphaned <title>: <reason>` and the `continue with` line. Any other run ends after its calls.

When a call runs again after a resume, `show` shows only its latest attempt. With `--json`, the command prints one JSON
object with both trees: `{ "runId", "workflow", "title", "status", "report"?, "error"?, "steps", "calls" }`, where
`steps` has the step lines of the text, without the first line and the footer. Each call is
`{ "kind", "runId", "label", "phase", "args", "state", "mark", "startedAt", "endedAt"?, "conversation"?, "result"?, "error"?, "calls"? }`,
with ISO times. `runId` is the ID of the run that made the call. `conversation` is the conversation ID of a `session` that opened. The JSON `mark` of a working session
is `✓`: only the text shows it as `◉`. `phase` is `null` before the first phase line. The `result` of a `run` call is
`{ "runId", "result" }`, with the result of its child run, and its `calls` are the calls of the child run.

With `--agents`, `show` prints the agents of the run, the tree that the [`/workflows`](#the-workflows-command) run
view shows:

```text
run <run-id> <workflow> <status> <title>
<phase line>
  ✓ <agent text>  <model>  <n> asks  <duration>
  ◉ run <workflow> <child run-id>
    <phase line of the child run>
      ✓ <agent text>  <model>  1 ask  <duration>
<report lines, or the failed and continue with lines>
```

- An agent is a `session` call that opened a conversation. Its text is the first line of its first prompt that is not
  blank. When other agents of the same run have the same first line, its text is the first line of its prompt that not
  all of them have, such as the region of one worker of a fleet. A session with no ask shows its label.
- The mark is `◉` while one of its asks works, `✗` when it or one of its asks failed, and `✓` else. The model is the
  model of the session; the line has no model when the session has none. The duration runs from its start to now while
  it works, else to the end of its last ask.
- A phase line comes before the first agent or child run under it. Other calls, such as `sh`, are not in the tree. The
  rows of a child run are indented by 4 more under its `run` line.

With `--agents --json`, the command prints one JSON object `{ "runId", "workflow", "title", "status", "ended",
"agents" }`, where `ended` is true when the run has ended, also when it waits for an answer.
`agents` has one object for each line of the tree, in order: `{ "kind": "phase", "depth", "text" }`, `{ "kind": "run",
"depth", "mark", "text" }` with the text `run <workflow> <child run-id>`, or `{ "kind": "agent", "depth", "mark", "text",
"phase", "model", "asks", "conversation", "startedAt", "endedAt"?, "facts" }`, where `phase` is the phase line of the
session, or `null` before the first phase line, `endedAt` is absent while the agent works, and `facts` is the text
after the agent text in its line, such as `sonnet  1 ask  31s`. `depth` is the nesting of child runs. `--calls` and `--agents` together are bad usage.

With `--pick`, on a terminal, the command asks `Pick an agent:` with the lines that `show` prints: the first line, the
steps, or the calls of a run without steps, then the footer. It prints the conversation ID of the agent of the line
that the pick takes, for [`attach --conversation`](#attach). Only a line with an agent can be taken; Enter on another
line keeps the pick open. The cursor starts on the first line with an agent, also after each change of the typed
filter. While the pick waits for a key, the command reads the run again 1 s after each read ends and draws the new
lines, such as new steps, new marks and elapsed times, with the typed filter kept. The cursor stays on a line with the
same agent, at the same rank among the lines with that agent, else on the last of them; else it starts again on the
first line with an agent. A read that fails keeps the lines it has.

- A step line has the first session that opened a conversation under the step: a `session` call whose phase line is the
  step, in the run of the step, or a session of a child run that a `run` call under the step started, at any depth. When
  a run has more than one step with the same text, such as the `split` of a campaign after a failed item, a session
  belongs to the last of them that started at or before it. The first session to start counts, so the summarizer of the run memory, which starts after the session whose note it
  compresses, never counts. A log line, and a line of a child run under a step, has the agent of the step.
- For a run without steps, a `session` line has its conversation, and an `ask` line the conversation of its session.
- The first line, a line outside every step, a step with no session, and the footer have no agent.

While no line has an agent and the run's task has not ended, the command reads the store again every second, and
Ctrl+C exits 130. A run that ended with no agent prints `workflows: run <run-id> has no agent` and exits 1. A cancel of
the pick exits 130. `--pick` without a terminal, or with `--calls`, `--agents` or `--json`, is bad usage.

`show` exits 0 for every run it can show. It reads the project store through pi-durable's storage functions, as `list`
does, and does not start the host. It reads the file read-only as `list` does. An unknown run ID, or a run directory
without a `project` file, prints the
`no run` error of `resume`. A run saved by an earlier version prints `workflows: run
<run-id> was saved by an earlier version of <workflow> and cannot be shown`, and a run saved by a later version prints
`workflows: run <run-id> was saved by a later version of <workflow> and cannot be shown`. These exit 1. Bad usage, such
as no run ID, prints `usage: workflows show <run-id> [--pick | [--calls | --agents] [--json]]` and exits 2.

## Attach

```sh
workflows attach <run-id> [--conversation <id>] [--side]
```

`workflows attach` opens one session of a run in Pi, as `harness attach --conversation <id>` does:

- The sessions are the agents of `show --agents`, the `session` calls of the run and of its child runs that opened a
  conversation, in the order they started. With `--conversation <id>`, only the session of that conversation counts,
  as `show --json` and `show --pick` give it.
- The command opens the session that works now, as `show --agents` marks it `◉`. When no session works, it opens the
  last session that started.
- It connects to the host of the run's project, and starts the host when none runs. It sends `watch` for the
  conversation of the session, so an unknown conversation fails before Pi starts.
- Outside Herdr, or in Herdr with no place to open Pi, it runs `harness --project <project> attach --conversation <id>`
  in this terminal, and exits with its code. A child that a signal ends exits 1.
- With `HERDR_ENV`, it opens Pi in Herdr and exits 0. With `--side` and `HERDR_PANE_ID`, it opens Pi in a new pane to
  the right of that pane. Else it opens Pi in a new tab of the Herdr workspace that has the run's worktree open, as
  `herdr worktree list` shows it. A run with no worktree, or whose worktree is gone or open in no workspace, opens the
  tab in the workspace of the pane `HERDR_PANE_ID`, as `herdr pane get <pane>` gives it in
  `result.pane.workspace_id`. Without `HERDR_PANE_ID` either, Pi runs in this terminal.

A run with no session prints `workflows: run <run-id> has no session`. A conversation that is not a session of the run prints
`workflows: run <run-id> has no session with conversation <id>`. An unknown run ID prints the `no run` error of `resume`, and a run
saved by another version prints the error of `show` with `cannot be attached`. A Herdr failure prints
`workflows: <error>`. These exit 1. Bad usage, such as no run ID or a second argument, prints `usage: workflows attach <run-id> [--conversation <id>]
[--side]` and
exits 2.

## Save

```sh
workflows save <run-id> <name> [--force]
```

`workflows save` writes the script of a run to `scripts/<name>.js` of the project folder, and prints the absolute
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

`@vzlentin/harness` is a dependency of `@vzlentin/workflows`, at the caret range of its `package.json`. The Pi
package `@vzlentin/pi-workflows` depends on `@vzlentin/workflows` and `@vzlentin/pi-agents`, which depends on
`@vzlentin/harness`, so `pi install npm:@vzlentin/pi-workflows` puts them all in Pi's npm folder, with one copy of
harness, and brings the `workflows` skill (see [Pi](#pi)). Without Pi, `npm install -g @vzlentin/workflows` installs the command and its harness. No setup step, install
script or install lock runs: npm is the only installer. The [README](../README.md) gives the install
lines.

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
  of its install, or `src/entry.ts` of a checkout. The Pi extension sets it too when it loads, see [Pi](#pi). A
  host that started with another version of workflows runs that
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
- The run lists its sessions in the session-scoped document `workflows.sessions` of the project store, keyed by the
  root run ID. Each record has `run`, `conversation`, `task` and `label`, the name of the agent profile that opened the
  session. A record that an earlier version saved can have no `label`. This `label` is not the call label of `show`.
- Each try of a run is a task that harness starts with the key `wf:<run-id>#<n>`, from 1. A new task of a run gets
  the highest `<n>` of the run's keys in harness's document of keys, plus 1. `stop`, and `resume` of a task that has not
  ended, reach the task by its own key in that document. A task that has no key there, such as one that no `start`
  created, fails them with `workflows: run <run-id> has no harness task key for its task <task-id>`.

### The `workflow` tool of the host

The entry also gives the conversations of the host the `workflow` tool: the project agent, its subagents, and the
subagents of sessions. The sessions of a run do not get it. `src/tool.ts` defines it once for the host and for Pi:
its description, its parameters, its output schema, the command arguments of a call, and the text and the outcome of a
result. The host tool has no prompt guidelines. It takes the parameters of
[The `workflow` tool](#the-workflow-tool) of Pi, and runs the `workflows` command of the same install as a child
process with the Node of the host, in the conversation's directory, with `--json`. It sets `HARNESS_PROJECT` to the
project of the host and `PI_SESSION_ID` to the conversation ID.

- When the command prints `run <run-id>`, the running output of the call gets `run <run-id>: if this call stops, the
  run is detached and goes on in the harness host; follow it with resume: "<run-id>"`. Each stderr line appends a line to the running output, the last progress line or the line itself,
  and sets the `details` of the call to `{ steps }`, the progress lines of the command then any other stderr line.
  The result keeps the last `details`.
- The result text of a finished run is the summary of Pi's tool, then the `report` lines. A run that waits for an
  answer has only the summary, `run <run-id> waits for an answer: <question>; answer it with resume: "<run-id>" and answer: "<your answer>"`, and is not an error. A failed, detached, stopped
  or host-stopped run is an error result with its summary, and keeps the structured output
  `{ runId, status, result?, report?, error? }`.
- `background: true`, with `name`, `script` or `resume`, adds `--background` to the command. With `save`, it is an
  error and no command starts. The result is `started`, which is not an error: `run <run-id> started in the
  background; its result comes as a message in this conversation when it ends; follow it with resume: "<run-id>", or
  stop it with the command workflows stop <run-id>`.
- A task whose input has `notify` posts its outcome to the conversation `parent` when it ends, after it ends its
  sessions and before its end commits. The post is a follow-up input of the entry kind `workflows.result`, with the
  data `{ runId, status }` and the text of the tool result for that outcome: `finished` with the report lines,
  `finished` with the question and how to answer it for a run that waits for an answer, `failed` with the error, or
  `stopped`. Its request ID is `workflows.result:<run-id>/<task-id>`, so a rerun of the
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

The `pi/` folder is the Pi package `@vzlentin/pi-workflows`, the Pi extension that gives Pi the `workflow` tool and
the `/workflows` command. Its `package.json` has the keyword `pi-package`, the Pi packages and `typebox` as peer
dependencies at `"*"`, and the version of `@vzlentin/workflows`. Its `dependencies` are `@vzlentin/workflows` at that
exact version and `@vzlentin/pi-agents` at a caret range; release-please sets the version and the dependency on
workflows. Both packages are released together, at one version: the publish job publishes the root and then `pi/`.

`pi.extensions` names `./index.ts` and the extension of pi-agents at both places where npm can put it,
`../pi-agents/index.ts` and `./node_modules/@vzlentin/pi-agents/index.ts`. Pi skips the one that does not exist, and
loads a file with the same real path once, also when Pi's settings list pi-agents too.

`pi.skills` names `./skills`, which holds the skill `workflows` (`skills/workflows/SKILL.md`), and the skills of
pi-agents at the same two places, `../pi-agents/skills` and `./node_modules/@vzlentin/pi-agents/skills`. Pi reads only
the resource types that a manifest names, and it loads pi-agents through the path of its extension, so the skills of
pi-agents need these paths too. Pi skips the one that does not exist, and loads a skill file with the same real path
once. The skill tells the model how to start and follow the runs of ship, campaign, rpi, thermoloop and judge with the
`workflow` tool, and to start or resume a run only when the user asks for one in his message. `/skill:workflows
<workflow> <input>` asks for a run: the first word is the workflow, and the rest is its input.

When Pi loads the extension, it resolves `@vzlentin/workflows/package.json` from its own folder, and:

1. It puts the `.bin` folder of the `node_modules` folder that holds `@vzlentin/workflows` last on the `PATH` of Pi's
   process, so Pi's tools find `workflows` and `harness`. It goes last because the folder also holds the commands of
   other dependencies, such as an older `pi`. It removes the folder first, so each load leaves it on `PATH` once.
2. It sets the entry `workflows` in harness's `entries.json` to `dist/entry.js` of that package, with the harness that
   the package imports, so a host that the tool starts loads the entry of the same install.
3. It loads `dist/tool.js` of that package, the definition of the `workflow` tool in `src/tool.ts`, and registers the
   tool with it.

When `@vzlentin/workflows` does not resolve, the load fails and Pi reports the error. In a checkout, `pi/` resolves the
checkout through the link `pi/node_modules/@vzlentin/workflows`, see the README.

The extension runs each workflow as a child process of the `workflows` command of its dependency
(`<package>/dist/cli.js`), with the Node that runs Pi, in the session's directory, always with `--json`. With `background`, the call returns at once, and the extension posts the outcome of the run to the
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
- `resume` runs `workflows resume <run-id>`. `answer`, with `resume` only, adds `--answer=<text>` and answers the
  question of a waiting run. With `name`, `script` or `save`, it is the error `answer works only with resume`, and no
  command starts. `answer` works with `background`.
- `save: { runId, name, force? }` runs `workflows save <run-id> <name>`, with `--force` when `force` is true. See
  [Save](#save).
- `background: true`, with `name`, `script` or `resume`, adds `--background` before `--json`. With `save`, it is the
  error `background works only with name, script or resume`, and no command starts.

The tool adds guidelines to the system prompt on how to write a `script`: its shape and `meta`, the script globals,
the sandbox and resume rules, `input` and how to answer a `waiting` result, `save`, and `background`. A test checks that they name every global of
`workflows/script.d.ts`.

Each stderr line of the run is a progress update of the tool. A progress line is a stderr line that is a JSON object
with a `progress` array, whatever the order of its keys. The text of an update is the last line of a progress line, or
the stderr line itself. The tool keeps only the last 100 stderr lines that are not progress lines, for the steps and
for the error text of a failed command. Esc sends SIGINT to the command, as Ctrl+C does, so the command
detaches after 2 s, and the run goes on in the host. The result then says to follow the run with `resume`, or to stop
it with `workflows stop <run-id>`.

In Pi, the call line is `workflow <name> <slug>`, `workflow <name>`, `workflow script`, `workflow resume <run-id>` or
`workflow save <run-id> <name>`, such as `workflow ship Fix the README typo` or `workflow optimize ship`. The slug comes from the first string arg: the
file name of a `.md` file without `.md`, or else the first 40 characters of its subject. Under it are the lines of the last `{"progress":[...]}` line of the command, as the
command draws them on a terminal, with the marks in the theme's colors, then the last 100 other stderr lines, such as a warning.
See [Progress](#progress). So a campaign shows its item steps with the ship steps of each item under them. The tool
does not make the steps itself. A finished run ends with its `report` lines,
such as `shipped Fix the README typo in 2 rounds, judge 1.00, 4dfb5c8 on fix/readme-typo`. A failed, detached or stopped run ends with
the error or the state, and the run ID to resume. The steps are in the `details` of each update and of the result, so the list draws the
same after a reload. The model gets the result text of the host tool: the summary, then the `report` lines of a
finished run that does not wait for an answer.

The tool declares an `outputSchema`, the union of the outcomes below, one object for each status. Its
`structuredContent` is `{ runId, status, result?, report?, error?, workflow? }`:

- `finished`: the run finished, `result` is its result, such as a `blocked` ship result, and `report` is its report
  lines. For a run that waits for an answer, `result` is `{"status":"waiting","question":"<question>",...}`, and the
  text is `run <run-id> waits for an answer: <question>; answer it with resume: "<run-id>" and answer: "<your answer>"`.
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
`{ runId, cwd, workflow }`, with the `workflow` of the outcome, and follows the run with `workflows wait <run-id> --json` in `cwd`. When the wait prints a
`finished`, `failed` or `stopped` outcome, the extension sends the message `workflow-result`, with the text of a
call without `background` for that outcome (the summary, then the report lines of a finished run; for a waiting run,
the question and how to answer it), the `details` `{ steps, outcome }`,
`display: true`, `triggerTurn: true` and `deliverAs: "followUp"`. It then appends the session entry
`workflow-background-end` with the data `{ runId }`. The renderer of `workflow-result` draws the steps and the outcome
as the tool result draws them, or the text of the message when its `details` are not valid.

At each `session_start`, the extension reads all the entries of the session, of every branch, and follows each run
whose last `workflow-background` entry comes after its last `workflow-background-end` entry. One extension instance
has at most one wait for a run, so a second `session_start` or a `background` resume of a followed run starts no
second wait. `session_shutdown` sends SIGINT to the waits, which detach and post nothing.

When the context of `session_start` has a UI (`hasUI`), the widget `workflows` above the editor shows the runs that
the session follows, in the order that they started to be followed, on one line:
`<workflow>: <id> <step> | <workflow>: <id> <step>`, such as
`campaign: 935f6d89 item 2/3: Add a thanks line › round 1/3: review | ship: e235d11b plan`. The workflow is the one of the
`workflow-background` entry, or `?` for an entry with no `workflow`. The short ID is the part of the run ID after its
last `-`. The step is the `status` of the last progress line of the wait, see [Progress](#progress), else its last
line, trimmed, with its mark, or `starting` before the first one; another stderr line does not change it. The
widget redraws when a run starts to be followed, at each progress line,
and at the end of each wait. When the session follows no run, the extension removes the widget. After shutdown, the
extension draws nothing. As `session_start` follows the pending runs again, they show again after a reload.

A `detached` or `host-stopped` outcome, an outcome line that is not valid, no outcome line, or a wait that does not
start posts nothing and appends no end entry. The extension then waits 1 s and runs the wait again, and doubles the time
before each next wait, up to 60 s. `session_shutdown` ends these retries, so the next `session_start` follows the run
again. A wait that exits 4 with no outcome line, for a run that is gone, posts nothing and appends the end entry with
the data `{ runId, reason }`, where `reason` is the error text that the tool gives for that output: the stderr text, or
`workflows exited with <code>` when it is empty, after `run <id>: ` when the wait printed its run line. A crash between the message and the end entry
posts the outcome again at the next `session_start`.

A call without `background` that resumes a run that the session follows gives the outcome in its own result. When that
result is `finished`, `failed` or `stopped`, the call appends the end entry, the wait posts nothing, and a wait
that waits to run again stops, so the run leaves the widget. Else the wait
posts the outcome that it gets.

A `save` call returns `{ runId, status: "finished", result: { file }, report: [file] }`, with the absolute path of the
file that it wrote. A `save` that fails is a normal tool error with the stderr text.

A failed, detached, stopped or host-stopped result is an error result that keeps `structuredContent`. Thus
`await tools.workflow({ name: "ship", args: { item } })` in a codemode script gets this object. A call that fails
before a run exists, such as an unknown workflow name, is a normal tool error with the stderr text. A call whose
command printed `run <run-id>` and then stopped with no outcome line is a normal tool error `run <run-id>: <stderr
text>`, or `run <run-id>: workflows exited with <code>` with no stderr, so the error keeps the run ID to resume.

### The `/workflows` command

`/workflows` composes [`workflows list`](#list), [`workflows show`](#show) and [`workflows attach`](#attach). It runs
`workflows list --json` in Pi's working directory, and lists the runs in that order, one line each:
`<run-id>  <workflow>  <status>  <title>`, under the title `Show workflow run`. With no run, it notifies
`No workflow runs in this project`. When the list fails, it notifies its stderr as an error.

The chosen run opens in the run view. It reads [`workflows show <run-id> --agents --json`](#show) at once, and again 2 s
after each read ends, until a read shows that the run ended, and draws its tree:

```text
<workflow> <run-id> <status> <title>
  <phase line>
    ✓ <agent text>  <model>  <n> asks  <duration>
>   ◉ <agent that works now>  <model>  1 ask  <duration>
    ◉ run <workflow> <child run-id>
      <phase line of the child run>
        ✓ <agent text>  <model>  1 ask  <duration>
up/down select an agent, enter attaches, escape closes
```

The view shows at most 30 rows, around the selected agent. It first selects the last agent that works, else the last
agent; a new read keeps the selected agent. A read that fails, or a `workflows` command that does not start, keeps the last tree and shows its
error under the tree, above the help line, until the next good read. Before the first good read, the
view shows `Reading the run...`, or the error of the last read in its place: the stderr of a `show` that fails, such as
`workflows: no run <run-id>`, or `workflows show did not print the expected JSON`.

Escape closes the view. Enter on an agent runs `workflows attach <run-id> --conversation <id>` when `HERDR_ENV` is set,
which opens the agent in a Herdr tab. Only `HERDR_ENV` counts, because `workflows attach` opens a Herdr tab only with
it. Without it, the command notifies `Run in another terminal: workflows attach <run-id> --conversation <id>`.
When the attach fails, it notifies the error `<stderr>. Run in another terminal: workflows attach <run-id>
--conversation <id>`.

## Run directory

Runs live in `$XDG_STATE_HOME/workflows/runs/<run-id>`, by default `~/.local/state/workflows/runs/<run-id>`:

- `project`: the name of the harness project whose store holds the run: its saved inputs, calls, sessions and progress

The project store is `$XDG_STATE_HOME/harness/<project>/durable.sqlite`. See [Runs in the harness
host](#runs-in-the-harness-host).

A ship run also has:

- `repository/`: the clone, for a GitHub repository only
- `.worktrees/repository/<run-id>/`: the worktree of the clone, for a GitHub repository only. The worktree of a local
  repository is next to that repository: see [The meta block](#meta)
- `round-<n>.patch`, `round-<n>-fix.patch`: the patches each review got, which its review child run writes there
- `memory/`: the OptMem store of the run memory

A campaign run has `repository/` and `.worktrees/repository/<run-id>/` in the same way, plus:

- `item-<n>/`: the `round-<n>.patch` and `round-<n>-fix.patch` files of item `n`
- `memory/`: the OptMem store of the run memory of every item

An `rpi`, `thermoloop` or `implement` run without a caller has `memory/`, the OptMem store of its run memory.

An optimize run has:

- `baseline/<path>` and `best/<path>`: the baseline texts of the edited paths and the promoted texts
- `notes.txt`: the note lines of the `compose` turn
- `overlay.diff`: the item lines, the reason lines, the edit lines and the diff
- `memory/`: the OptMem store of the run memory, with one row for each item

A child run that `run()` starts is a run directory of its own, next to the caller's, without a `project` file: it is a
task of the caller's run. A child run without a worktree can have an empty run directory.

## Prompts

`workflows/prompts/` holds the Pi prompt templates `research`, `plan`, `handoff`, `implement`, `review`, `judge` and
`commit`, `split` and `rundown` for `campaign`, and `inv`, `dom`, `compose` and `select` for `optimize`. Edit the wording there. Keep the
frontmatter and the last line `$@`: the run removes them, then adds its inputs as `## <name>` sections.
`workflows/scripts/thermoloop.js` adds the rules of the [review loop](#thermoloop), so a template edit cannot
remove them. `memory(...).session(...).noted` of the [script lib](#the-script-lib) adds the `respond` answer rule
of the handoff and implement turns. In the same way,
`workflows/scripts/campaign.js` adds the `respond` answer rule of `split`. The judge rubric is fixed: its eight
answers, in question order, make the score. `judge`, `commit` and `rundown` hold their own `respond` answer rules. A run uses the
templates as they were when it started.

Workflow scripts get every template of `prompts/` as `prompts.<name>`, and the agent profiles of `agents/` as
`agents.<name>`, from the package and the project. A run
uses the profiles as they were when it started.

## Source

The engine files in `src/`:

- `cli.ts`: the `workflows` command entry point.
- `cli/main.ts`: the command line: the terminal, the table of commands, usage and `--version`.
- `cli/host.ts`: the connection to the harness host, the task keys, the run directories and the project store file.
- `cli/saved.ts`: the saved runs of the command: their run directory, root tasks and their keys, the status that
  `list` and `show` print, and progress.
- `cli/follow.ts`: how the command follows a run to its outcome, the answer of a waiting run, and the Ctrl+C presses.
- `cli/commands/`: one file for each command: `start.ts`, `resume.ts` (also `wait`), `stop.ts`, `list.ts`, `show.ts`,
  `attach.ts`, `save.ts` and `prune.ts`.
- `cli/terminal/pick.ts` and `cli/terminal/keys.ts`: the picker of `list --pick` and `show --pick`, and its keys.
- `entry.ts`: the entry that the harness host loads, with the script task.
- `records/tree.ts`: the call tree of a saved run, its lines and agent rows for `show` and `attach`, and the lines of
  `show` with the agent of each step, for `show --pick`.
- `records/steps.ts`: the tree of steps of a run.
- `records/store.ts`: the command's read-only reads of the project store: the tasks of the runs, harness's task
  keys, their progress and calls.
- `cli/terminal/redraw.ts`: how the command draws the tree of steps of a run on stderr.
- `launch/input.ts`: the generic entry point `workflows <wf>`: the checked arguments of a run, its run ID, its saved
  input, and the input of a child run.
- `launch/args.ts`: the `meta.args` values of the command line, and the texts that they name, and the args of a
  `run()` call, with one check of both against `meta.args`.
- `launch/worktree.ts`: repository selection, the worktree of a run, made by Herdr or Git, and the name of its branch.
- `run/result.ts`: the title of a run, and the status, report lines and exit code of its result.
- `workflow/meta.ts`: read and check the `meta` of a workflow script.
- `workflow/find.ts`: find a script, list the scripts, help and usage, usage errors, and the terminal input and output.
- `workflow/bundle.ts`: the bundle of a run (scripts, prompt templates, agent profiles and the script lib), the
  instructions of a prompt template, and the edits of the bundle for a `run()` call.
- `cli/commands/check.ts`: the static analysis of `workflows check`.
- `run/version.ts`: the kind and version of the script task, and the task types that the `run/` files share.
- `run/past.ts`: the saved root runs of the project store, for the `pastRuns` call and `run(name, { from })`, the task
  of a run that the commands go by, and `runStatus`, the one place that computes the status of a run.
- `run/progress.ts`: the progress events of a run, their document, and the lines that wait for the next call.
- `run/calls.ts`: the workflow script calls and their records in the project store.
- `run/sessions.ts`: the sessions on harness's children library, and the end of the sessions of a run.
- `run/child.ts`: the child runs that the `run` calls start.
- `run/sandbox.ts`: the run of a script in the sandbox, with its globals and prompts.
- `run/task.ts`: the task of every script run, its phase, its outcome, and the message of a background run.
- `git.ts`: run a process, and Git commands.

The script side in `workflows/`, published as it is:

- `scripts/`: the workflow scripts of the package.
- `lib/`: the helpers that every workflow script gets, in themed files. They run in the sandbox. A function that
  needs only the script calls goes here; one that needs Node or the store, or that every script must have, such as
  the lockdown of `Date` and `Math.random`, stays in `src/`.
- `prompts/` and `agents/`: the prompt templates and the agent profiles.
- `script.d.ts` and `jsconfig.json`: the types of the script globals and the lib, for editors.
