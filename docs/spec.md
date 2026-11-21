# workflows reference

The behaviour of the `workflows` command, the workflow scripts, runs and the `workflow` tool. The
[README](../README.md) has the install.

`workflows ship` ships one work item onto a new branch through [Pi](https://github.com/earendil-works/pi) sessions.
`workflows campaign` splits a goal into work items and ships them one after another onto one branch.
`workflows rpi` researches, plans and implements one work item in one commit, `workflows thermoloop` reviews a change
(the current branch, a PR, a ref or a range) and fixes it in rounds, and `workflows judge` judges it.
`workflows optimize ship` proposes edits to the ship prompts, skills and `AGENTS.md` from past ship runs,
and keeps them when a blind judge prefers the diffs they give. `workflows land <change>` lands a branch, the head branch
of a PR or the branch of a run on `main` when its CI passes. The run is
headless and resumable. It runs in the [harness](https://github.com/Vzlentin/harness) host of its project, whose
[pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) store keeps the sessions, model calls, tool
calls and the progress of the run. See [Runs in the harness host](#runs-in-the-harness-host).

`src/` is the engine that runs workflows: run directories, the script task, sessions, retries, resume and
workflow scripts. Every workflow script is a command: `workflows <wf>` runs `.workflows/scripts/<wf>.js` of the project or `workflows/scripts/<wf>.js` of the package, and the `meta` at
the top of the script declares its arguments. See [Workflow scripts](#workflow-scripts). `workflows/scripts/ship.js` and
`workflows/scripts/campaign.js` are scripts of the package. `ship` selects the repository and creates the worktree, through its
`meta`, then runs in the worktree the child runs `workflows/scripts/rpi.js` and `workflows/scripts/thermoloop.js`, the commit
message turn and the squash, and the child run `workflows/scripts/judge.js` on the squashed commit. `campaign` does the same, runs
`workflows/scripts/ship.js` once for each work item, and `workflows/scripts/judge.js` once on the change of all the items.
`workflows/scripts/optimize.js` runs `workflows/scripts/ship.js` once for the candidate on each work item, and again
for a baseline that cannot be kept.

```text
research session:   research (documents the code as it is)
plan session:       plan (with the research)  ->  handoff
implement session:  implement the handoff                      <- round 1, then each round after FIX
review session:     review (SHIP or FIX)  ->  handoff (on FIX, back to implement)
commit session:     commit message, then the squash, after SHIP
judge session:      fixed rubric, on the squashed commit
```

The research, plan and first implement sessions are `workflows/scripts/rpi.js`, the review sessions and the implement
sessions after them `workflows/scripts/thermoloop.js` (at most `--rounds` reviews), the commit session `commitChange` and
`judgeCommit` of the script lib, which `ship.js` calls, and the judge session `workflows/scripts/judge.js`.
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
changes`; each review step logs `SHIP` or `FIX`. A failed commit message turn logs `commit message failed on <subject>:
<error>, so the message is the subject of the item`. After the squash, the run logs `commit <commit> <subject>`, or
`nothing to commit since <commit>` when the work changed nothing since its start. Then the judge step logs
`judge <score>`. See the example of [Campaign](#campaign).

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
<note>` line for each note and no summaries. In both stores, each note has the key `<run-id>/<note>.<n>`, the stored
note line and the count `<n>` of that same line among the notes that this execution added, from 1, as one line of
`memory/notes.keys`. In an OptMem store, the key is written after `memo note`
succeeds, and an add whose key is there runs no `memo note`. In the plain store, `<k>` is the line of its key, from 0.
So an add that runs again at resume adds no note, a resume that adds the notes in another order gives each note its
own key, and plain adds that run at the same time get different numbers. The
run logs `memo of OptMem is missing, so the run memory keeps
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

On SHIP, a new `implementer` session gets the `commit` prompt with the inputs `item`, `base`, the start commit, and
`head`, the commit of `HEAD`, and no `findings` input, which only a fix round gives (see [Fix](#fix)). It reads `git log base..head` and `git diff base head`, and answers through `respond`
with `subject` and `body`: a commit message that follows the commit rules of the repository. The run squashes the work
into one commit with the message `<subject>`, an empty line, then `<body>`:

```text
fix: correct the README typo

The README said wrold. It now says world.
```

When the body is empty, the message is `<subject>` alone. If the message turn fails or answers an empty `subject`, the
message is the subject of the work item alone: its first non-empty line without leading `#`. A failed message turn
prints `commit message failed on <subject>: <error>, so the message is the subject of the item` on stderr, and the
report has that line too. The failure is the saved result of the turn, so a resume does not ask again.

Then the run starts the child run `judge` in the worktree, with the work item and the start commit, so the judge
judges the squashed commit and its message: see [Judge](#judge). If the judge fails or does not answer through
`respond`, the child run fails, so the run fails as [Resume](#resume) says, and keeps the squashed commit. A resume
judges the commit again.

The status of the run follows the judge: `shipped` when the score is above 0, and `rejected` when it is 0. The command
prints `<status> <subject> in <n> rounds, judge <score>, <commit>`, then
the line `commit message failed on ...` when the message turn failed, then the line `branch <name>` of
[Branch name](#branch-name). It exits 0 when `shipped`, and 1 when `rejected`, which keeps the squashed commit, the
branch and the worktree.

The result of the run, which `--json` prints, has `status` and `rounds`; `head`, `subject`, the subject of the
squashed commit, when `shipped` or `rejected`; `change`, the main checkout and the branch that the worktree ends on, for
every status, as [Branch name](#branch-name) gives it; `score`, `answers`, the eight answers in question order, and `findings`, the finding
lines of the judge, when the judge answered; `divergence`, the divergence line of
the judge with its whitespace runs made one space, when the judge answered; `reply` when blocked; `handoff`, the
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
`rounds`, which is 1, and `handoff`, the planner's handoff, as a blocked thermoloop has. A run with a worktree of its
own has `change`, as [Branch name](#branch-name) gives it.

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
judge's findings as a list of lines, `message`, the commit message of the implement turn, and `memory`, the `ref` of a
run memory to go on with. It runs the child run `implement` with the work item, then `## Judge findings` with one
`- <finding>` line for each finding, as the plan, from `--start`. Then a new `implementer` session writes the commit
message of the change from `--start`, and the run squashes the change into one commit with it, as `ship` does: see
[Ship](#ship). The `commit` prompt also gets the input `findings`, the findings joined with newlines, and asks for a
message that fixes the findings about the commit message. When the squashed commit has the same tree and the same
message (`%B`) as `HEAD` before the implement, the round is blocked: the run resets `HEAD` back to that commit with
`git reset --soft` and runs no judge. Else it runs the child run `judge` on the squashed commit.

The result is `{ "status": "judged", "shipped", "reply" }`, with `shipped` the result of `judgeCommit`: `{ "head",
"subject", "score", "answers", "findings", "divergence" }`, `head` the short squashed commit and `subject` its subject.
The command prints
`judge <score>: <subject>`, one line `  <finding>` for each finding, and the line `commit message failed on ...` of
[Ship](#ship) when the message turn failed, and exits 0. A score of 0 gives the status
`rejected` in place of `judged`, and exits 1. When the implement is blocked, because the item has no change from `--start`, or the
round left the same tree and message as `HEAD` before it, the result is `{ "status": "blocked", "reply" }` and the command prints `blocked <subject>` and the reply. When a child
run fails before the judge, the run does not fail: the result is `{ "status": "failed", "error" }`,
with `reply` when the implement ended, and the command prints `fix failed on <subject>: <error>`. So a caller saves the
result, and a resume does not run the fix round again. These two exit 1. A judge that fails or does not answer through
`respond` fails the run, so a resume judges the squashed commit again. A child run that was aborted or orphaned,
whose error is `child run <id> aborted: <reason>` or `child run <id> orphaned: <reason>`, fails the run with that error,
so that a resume of the caller runs it again.

## Thermoloop

```sh
workflows thermoloop
workflows thermoloop 74
workflows thermoloop HEAD~1 --item "Fix the README typo"
workflows thermoloop main..feature --rounds 2
workflows thermoloop --repo ../calibre --item item.md
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
- A local branch that another worktree has checked out, other than the current branch and `--base`, such as
  `change.branch` of a `ship` result: from the merge base of `--base` and the branch to the branch.
- Any other value is a ref: from the merge base of the ref and `HEAD` to `HEAD`, such as `HEAD~1` for the last commit.

The work item, which says what the change should do, is the option `--item`, as a `.md` file, inline text, or stdin
with the rules of `ship`. A blank stdin counts as no work item. Without it, the intent is `# <title>` and the body of
the pull request: of the number, or else of the branch of the change through `gh pr view <branch> --json title,body`.
When there is no pull request or `gh` fails, the intent is the commit messages of the change, oldest first.

The run works in the current checkout when the change ends on its `HEAD` or on its current branch. There, it first
commits the changes that are not committed, untracked files included, as one commit `wip`. When the change ends on
another branch, the run starts itself again as a child run on that branch. When another worktree has the branch
checked out, the child run gets `repo` with the path of that worktree and works there, as `--repo` does. When no
worktree has it, such as a pull request that is not checked out here, the child run gets `checkout` and works in a
worktree on that branch, next to the repository, as `meta.worktree` places it: see [Child runs](#child-runs). Its
report gets the last line `worktree <path>`, its `change` is the main checkout and the branch of that worktree, and
the current checkout stays as it is. The run worktree stays after the run. The thermoloop fails with `the worktree
<path> of <branch> has uncommitted changes` when the other worktree that has the branch has changes that are not
committed, and a change that does not end on a branch, such as `main..<commit>`, fails with
`the change ends on <end>, which is not a branch`. A change with no change from its start fails with `no change from
<from>`, where `<from>` is `--base`, the base branch of the pull request, or `A` of the range or the ref, before any
session.

`--repo <path>` runs the thermoloop in the checkout of a local repository, with the rules of `repo: true` in
[`meta`](#meta). The change, the `wip` commit and the round commits are those of that checkout.

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
`change`, the main checkout of the repository and the output of `git branch --show-current` in the checkout of the
review (no `change` on a detached HEAD), `rounds`,
`handoff`, the handoff that the last round used, when blocked or stopped, `memory`, and `reply` when blocked. Without a caller, the run
ends with the harvest of `ship` at each end: approved, stopped or blocked. Its result then has `lessons`, and the report
has a line for each lesson. A run that runs again in a worktree gives the lessons of that child run.

## Judge

```sh
workflows judge
workflows judge 74
workflows judge main..feature --item item.md
```

`workflows judge [<change>]` judges a change against its intent with the fixed rubric of `prompts/judge.md`. The
change, `--base`, `--repo`, `--item`, the intent and the worktree of a change on another branch are as in
[Thermoloop](#thermoloop). The judge changes nothing: it commits no `wip`, and when the checkout has changes that are
not committed, it logs `uncommitted changes are not judged` and adds that line at the end of its report. `ship`, `fix` and
`campaign` give it `start`, the commit that the change starts from, and `item`. Its step is `judge`. As a child
run, it also takes `overlay`: see [Child runs](#child-runs).

The judge session reads the commit messages and the diff of the change, and answers through `respond`: eight PASS or
FAIL answers, one line for each finding (a failed question can have several), and the divergence. If question 1
(complete) or 2 (correct) fails, the score is 0. Otherwise the score is the fraction of questions 3 to 8 that pass. The
step logs `judge <score>`. The command prints `judge <score>: <subject>`, then one line `  <finding>` for each finding,
and exits 0. The result is `{ "status": "judged", "change", "score", "answers", "findings", "divergence" }`, with
`change` as in [Thermoloop](#thermoloop), and `divergence`
the one line of the judge on how the change differs from its intent, or `none`, with its whitespace runs made one space.
A score of 0 gives the status `rejected` in place of `judged`, and exits 1.

If the judge fails or does not answer through `respond`, the run fails with that error, as [Resume](#resume) says,
and a resume asks the judge again.

## Campaign

```sh
workflows campaign goal.md
workflows campaign --repo calibre --base develop --rounds 2 "Make the docs complete"
```

The goal comes from one argument or from stdin, as the work item of `ship` does, and `--repo`, `--base`, `--rounds`
and `--prompts` work as for `ship`. `--rounds` applies to each work item. Errors name the goal, such as `the goal is empty`.
When the judge of an item fails, the item's ship fails, so the campaign fails, and a resume judges the item again.

In the step `split`, a planner session splits the goal into work items with the `split` prompt, and answers through
`respond` with a `subject`, a Conventional Commit subject for the whole goal, and the work items. The step logs the
number of items, such as `2 items`. Then each
work item ships in turn, in one worktree on the branch `campaign/<run-id>`, or `--branch`: the research, the plan, the rounds, the
review, the squash and the judge of `workflows/scripts/ship.js`, from the commit that the item before it made. So each shipped
item is one commit, with the commit message that its own commit turn wrote, as in `ship`. No `ship/<run-id>` branch is made,
and nothing is merged or pushed. Each item is a ship child run, with its own
run ID and run directory, in the store of the campaign run: see `run` in [the script API](#the-script-api).

After the split, the campaign opens one run memory, the store `memory/` in its run directory, as `ship` does, and
gives its path and the item number to each ship. So the notes of an item are `item <n> <author>...` lines, and the
sessions of the next items see them.

The items of the split do not change while they ship. Only a failed item changes them: see below.

The list of todos of the campaign run, as in [Todos](#todos), has one todo for each item, in the order of its split.
The text of the todo is the subject of the item, as the item step shows it:

- After each split, the run adds the todos of its items, with the state `open`.
- At its item step, the todo of the item becomes `doing`. It stays `doing` during the fix rounds of the item, and while
  the run waits for an answer about the item.
- When the item ships, also after a fix round or on the answer `keep`, its todo becomes `done`.
- When the run resets the item, its todo becomes `dropped` at the reset, before the rundown question. When the user
  stops the campaign at the item, its todo is `dropped`, and the todos of the items after it stay `open`.
- When an answer to the rundown question makes a new split, the todos of the remaining items of the old split become
  `dropped` before the step `split`, and the new split adds one todo for each of its items.

The step `all <n> item(s)` adds no todo. Each ship child run keeps its own list, and makes no todo call, so its list
is empty. `workflows show <run-id> --json` gives the list of the run as `todos`.

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
  commit a1b2c3d fix: correct the README typo
  ✓ judge  19s
    judge 0.83
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
  campaign branch and resume`. So `change` of the result always has the campaign branch.
- When every item shipped, the step `all <n> item(s)` runs the child run `judge` on the change of the whole campaign,
  from the start commit to the last item, against the goal: the judge of an item sees only its item, and not how the
  items fit together. The command prints
  `<status> <subject> in <n> item(s), judge <score>, <commit>` with the commit of the last item, then one line
  `  <commit> <commit subject>, judge <score>` for each shipped item, in order, with
  `, divergence <divergence>` at the end when the item's divergence is there, not empty and not `none`, then one line
  `  finding <finding>` for each finding of the campaign judge, then the lesson lines, then the line `branch <name>` of
  [Branch name](#branch-name), with the `subject` of the last split. The campaign judge gives the status: `done` and
  exit 0 when its score is above 0, and `rejected` and exit 1 when it is 0. The commits and the branch stay in each
  case. A campaign judge that fails fails the run, and a resume judges the campaign again.

- An item whose ship is `shipped` ships. An item whose ship is `rejected` (a judge score of 0) and whose judge gave
  findings gets one fix round: the child run
  [`fix`](#fix) with the work item, `start` at the commit that the item started from, the judge's findings, `round` at
  the rounds of the item plus 1, the message `fix: judge findings of item <n>` and the run memory of the item. `fix`
  squashes the change of the item again into one commit with a new commit message, and logs
  `commit <commit> <commit subject>`. When `fix` is `judged`, with a score above 0, the item ships: its result is the
  ship result with the status `shipped` and the judge fields of the ship result replaced by the `head`, `subject`,
  `score`, `answers`, `findings` and `divergence` of `fix`. The step `fix` comes
  under the item step, and its log line and its `judge` step under it:

  ```text
  ✓ item 1/2: Fix the README typo  6m12s
    ...
    commit a1b2c3d fix: correct the README typo
    ✓ judge  19s
      judge 0.00
    ✓ fix  1m20s
      +1 -1 in 1 file
      commit b2c3d4e fix: correct the README typo
      ✓ judge  18s
        judge 0.83
  ```

  Otherwise the fix round ends with an outcome: `the fix round failed: <error>` when `fix` is `failed`, `the fix
  round left no change` when it is `blocked`, `still 0
  after one fix round` when it is `rejected`, a score of 0 again, and `the fix round ended with the unknown status <status>` for any
  other status. After a score of 0 again, the run asks as below; after any other outcome the item fails
  as below. A judge that fails in the fix round fails `fix`, so the campaign fails, and a resume judges the item again.
- When an item's ship is `rejected` with no findings, or its fix round ends
  with a score of 0 again, the item is one squashed commit, and the run asks the question of
  [Input](#input), with no reset, no patch and no rundown:

  ```text
  Item <n> <status>: <commit> <commit subject>

  Findings:
  - <finding>

  How should the campaign continue? Answer keep to ship the item as it is, fix: <words> for one more fix round on your words, or reset to reset the item and get a rundown. Answer stop to end the campaign and keep the commit.
  ```

  `<status>` is the status of the `rundown` input below. The findings are those of the last judge that gave some, and
  the block is left out when there are none. The command prints the question and exits 3 with the status `waiting`.
  The run trims the answer, and matches `keep`, `reset`, `stop` and the prefix `fix:` in any case:
  - `keep` ships the item as it is: its entry in `items` gets `"kept": true` and `findings`, the findings of the
    question, and its item line in the `done` report is followed by one line `    finding <finding>` for each of them.
  - `fix: <words>`, with words that are not empty, runs one more fix round as above, with the words as its one finding
    and `round` one more than the fix round before it. A score above 0 ships the item, a score of 0
    again asks again, and any other outcome fails the item as below.
  - `reset` fails the item as below.
  - `stop` prints `stopped <subject> at item <n>: <worktree>`, then the lesson lines, and exits 1.
    The commit of the item and the branch stay, and the result has no `rundown`.
  - Any other answer asks the same question again, after the line `Unknown answer: <answer>` and an empty line.
- When an item is blocked or stopped, its fix round fails, leaves no change or ends with an unknown status, or the
  answer to the question above is `reset`, the item fails. The run writes the change of the item, from
  the commit that the item started from to `HEAD`, as `item-<n>/item.patch` in the run directory. It checks that the
  commit that the item started from is the last shipped commit, or the start commit when no item shipped, and that
  `HEAD` contains it; else the run fails with `HEAD <commit> does not contain the last shipped commit <commit>: the
  campaign does not reset it`. Then it resets the worktree with `git reset --hard` to that commit, and adds the note `campaign: item <n>
failed and was reset: its notes describe code that is gone` to the run memory. Then a new planner session gets the
  `rundown` prompt with the inputs `goal`, `shipped` (the shipped items, each one as `{ item, commit, divergence }`, as JSON), `item`, `status`
  (the ship status, or `shipped with judge score 0`, with `, <outcome>`
  of the fix round after it when the item had one), `reply` (the reply of the fix round's implementer after a fix round that has one), `handoff`, `findings` (the findings of the
  fix round's judge when it gave some), `memory` (the notes of the run memory of the campaign, as `#<k> <note>` lines), `remaining` (the
  remaining items, as JSON) and `patch` (the path of `item-<n>/item.patch`, when the item changed something). Empty inputs are left out. It answers through `respond` with a rundown, suggestions and proposed items.
  The run asks the question of [Input](#input): the question summary, which is the rundown, after a fix round
  `Fix round: <outcome>` with one `- <finding>` line for each finding of the fix round's judge, `Suggestions:` with one
  `- <suggestion>` line each, `Proposed items:` with the numbered items, and `Patch of the failed item: <path>` when
  the patch exists, then `How should the campaign continue? Answer stop to end it.` The command prints
  the question and exits 3 with the status `waiting`. Continue with `workflows resume <run-id> --answer <text>`.
- When the answer is `stop`, in any case, the command prints `stopped <subject> at item <n>: <worktree>`,
  with the path of the campaign's worktree,
  then the rundown, then the lesson lines, and exits 1. The branch keeps its name `campaign/<run-id>`, or `--branch`.
- Any other answer goes back to the step `split`: a new planner session with the `split` prompt and the inputs
  `goal`, `shipped`, `rundown` (the whole question summary) and `answer`. Its items replace the remaining items on the
  same branch, and the next item has the next item number. A later failure asks again. The campaign ends as a campaign
  with no failed item.

`<subject>` is the first non-empty line of the goal without leading `#`. `<n>` in the `done` line counts the shipped
items. The number of the item step counts every item that ran. The result is
`{ "status": "done", "subject", "head", "score", "findings", "change", "items": [{ "item", "result" }], "lessons" }`,
where `score` and `findings` are those of the campaign judge, as in a ship result, with the status `rejected` when the
campaign judge gave 0, or `{ "status": "stopped", "items", "rundown", "lessons", "change" }`,
with no `rundown` when the user stopped at the question about an item still at 0. An item that the user kept has `"kept": true` and `findings`. The `result` of
each shipped item, and of the failed item in a stopped result, is its `ship` result, with its `divergence` and its child run ID as
`runId`, and after a fix round that shipped, that the user kept or at which the user stopped, the `head`, `subject` and judge fields of the last fix round. `head` is the commit of the last item, and `change` has the main
checkout and the branch that the worktree ends on, as [Branch name](#branch-name) gives it.

## Optimize

```sh
workflows optimize ship
workflows optimize ship --limit 4
workflows optimize ship --runs <run-id>,<run-id>
workflows optimize --workflow ship --items items/
workflows optimize ship --always-on-max 2000
```

`workflows optimize ship` proposes one overlay of edits to the ship prompts, skills and `AGENTS.md`,
ships each work item again with it, and keeps it when a blind judge prefers its diffs. It never changes `prompts/`,
the skills or `AGENTS.md`: the result is a diff to apply by hand. It is the package script `workflows/scripts/optimize.js`. The workflow to optimize,
`ship`, is one argument or `--workflow`, and defaults to `ship`.

The work items and their baselines come from one of two places:

- By default, from past runs: `pastRuns("ship", ...)` gives the completed root ship runs of the project store, the
  newest `--limit` (default 8), or with `--runs` the run IDs of that comma list, in that order. A saved run keeps its
  result as its baseline when its status is `shipped` or `rejected` and its `head` is still a commit of its repository; its diff is
  `git diff <start> <head>`. Any other saved run runs its baseline again once, as the child run
  `run("ship", { item, repo: repository, base: start, from: runId })`, with its saved prompts and agents table.
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

The texts that the run can edit are the baseline texts by path: `prompts/<name>.md` of the saved bundle of the first
past run, or with `--items` the `prompts/<name>.md` templates of the run's bundle (so `--prompts <folder>` sets the
templates), from `prompts`. `inv`, `dom`, `compose` and `select` are not among them. One turn of the `inv` prompt, in
a new session of the role `default`, gets the texts and the
traces of the baselines as JSON: for each one its run ID, the work item, `status`, `rounds`, `findings`, `divergence`,
`lessons`, and `notes`, the notes of its run memory from the `memory` field of its result. It answers
`{ edits: [{ path, text, moment }] }`: `text` is the new text of `path`, or null to remove it, and `moment` names the
run and the finding or note that the edit answers. No edit, a path that is not one of the texts (this includes a path
outside `prompts/`), or a path twice fails the run.

The surface texts come from the repository and the start commit of the first item: `AGENTS.md` at the start, when it
exists, each `.agents/skills/<name>/SKILL.md` and `.pi/skills/<name>/SKILL.md` at the start, and each
`<root>/<name>/SKILL.md` file of the user skill folders, the roots `${PI_CODING_AGENT_DIR:-~/.pi/agent}/skills` and
`~/.agents/skills`. One turn of the `dom` prompt, in a new session of the role `default`, gets the surface
texts, the same traces and the roots as JSON, and answers edits in the same shape; no edit is allowed. A path that is
not `AGENTS.md`, a project skill path or `<root>/<name>/SKILL.md` fails the run with
`dom edit <path> is not a skill or AGENTS.md path`, and a path that is also an `inv` or `dom` edit path fails it with
`dom edit <path> comes twice`.

One turn of the `compose` prompt, in a new session of the role `default`, gets the `inv` and `dom` edits,
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
`git diff <start> <branch>` in the repository of its `change`, with `<branch>` the branch of its `change`. Then its
worktree and its branch are removed: the worktree that `git worktree list` of that repository gives on the branch. A
removal that runs again finds nothing to remove: the worktree removal runs only `git worktree prune` when the folder
is gone, which removes only the registrations whose folder is gone, and the branch removal does nothing when the
branch is gone. When
the worktree removal fails, the worktree and the branch stay, and the report gets the line
`kept <worktree> on <branch>: <error>` before the last line. When only the branch removal fails, the branch stays, and
the report gets the line `kept branch <branch>: <error>` before the last line. Its run directory stays. The worktrees and
branches of the past runs stay.

For each item, one turn of the `select` prompt in a session of the role `judge` gets only the work item and the two
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

## Land

```sh
workflows land <change>
workflows land <change> --wait 600
```

`workflows land <change>` lands a change on `main` with no model call. The change is a PR number, a local branch, or
the ID of a completed root run of any workflow in the project store. Neither the workflow nor the status of the run
matters. It runs these steps in order, with `git -C` in the repository of the change:

1. Find the change, in this order. A number is a PR: `gh pr view <n> --json number,headRefName,isCrossRepository`
   gives the branch `prBranch(pr)`, `pr/<n>` for a PR from another repository, else its head branch. `land` does not
   fetch the PR, so its branch must already be local. Else a local branch of the main checkout of the current
   directory is that branch. For both, the repository is that main checkout, the first entry of `git worktree list`.
   Else the change is a run ID: `pastRuns(null, { runs: [<change>] })` gives the run, and `result.change` its
   repository and branch. It refuses a value that is none of these (`<change> is no PR number, no branch of
   <repository> and no completed run`), and a run with no `result.change` or an empty branch in it (`the run <run-id>
   has no change`, such as a run on a detached HEAD, or a run that an earlier version saved). It refuses the branch
   `main` (`the branch is main`) and a branch that the repository does not have (`the branch <branch> is not in
   <repository>`). `git worktree list --porcelain` of the repository gives the main checkout, its first entry, and the
   worktree on the branch, if any. It refuses a worktree on the branch that is gone, or that has changes that are not
   committed, also untracked files.
2. Check `main`: when the main checkout is on the branch, `git switch -q main` first; step 1 found it clean. Then it
   refuses a main checkout that is bare, is not on `main`, or has changes that are not committed. It
   runs `git fetch -q origin`, and refuses when `main` differs from `origin/main`, except when `origin/main` is already
   the head of the branch and `main` is an ancestor of it, as after a step 5 that stopped between its push and its
   merge. It refuses a branch that is not a fast-forward of `main`.
3. `git push -q origin <head>:refs/heads/<branch>`.
4. Wait for the CI of the branch, then refuse when it did not pass.
5. `git push -q origin <head>:refs/heads/main`, then `git merge -q --ff-only <head>` in the main checkout. The push
   comes first, so that a rejected push leaves `main` untouched on both sides. When `main` is already the head, both
   do nothing.
6. Delete the branch on `origin` when `git ls-remote` still lists it, and its remote-tracking branch.
7. For a run whose `serves` is an item, `{ "item": <n> }`: link the item to the head with the edge
   `item:<n> landed commit:<full head>`, then read the item. When the item has a `serves` edge from an `agent:` end,
   read the tree of the project: an `agent` node that serves `{ "kind": "item", "id": <n> }` and whose state is not
   `ended` is a live agent. With no live agent, set the item to `done`; with one, the item stays `open`. These are
   `harness` calls of the land run. The step never sets an item to `open`. It adds the report line `item <n> done` or
   `item <n> stays open: <node name> serves it`. A failure, such as the refusal of the host while a run that serves
   the item is live, adds `check failed: item <n>: <message>`, and the status does not change. A branch, a PR, and a
   run that serves no item or a parley, skip the step.
8. Wait for the CI of `main` at the head.
9. Run `workflows sweep <branch> --yes` of this package (`workflowsCommand`) in the repository (see
   [Sweep](#sweep)), unless the local branch is already gone. It removes the worktree that has the branch and the
   local branch, and marks each run of the branch `landed`.
10. Check the repository: `core.bare` is not true, `main` equals `main` on `origin`, and the branch is gone locally, as
   a remote-tracking branch and on `origin`.

A CI wait is one shell command in the main checkout. Every 15 seconds it runs
`gh run list --commit <head> --branch <branch> --json databaseId,workflowName,status,conclusion,url`, until the list
is not empty and each run has the status `completed`, or until `--wait` seconds have passed (default 1800). The CI
passes when each run ends with `success`, `skipped` or `neutral`. Otherwise its reason is `no CI run for <short> on
<branch> after <wait> s`, `CI failed on <branch> at <short>: <workflow> <url>, ...` with each failed run, or `the CI
of <branch> at <short> did not finish in <wait> s: <workflow> <url>, ...`, where `<short>` is the short head. No CI is
not a green CI.

The result is `{ "status", "head", "change", "report" }`, with `head` the short head and `change`
`{ repository, branch }`. `change` is there once step 1 resolved it, and `head` once step 1 found it. A failed step from 1 to 6, or a failed Git or `gh` command in it, gives the status `refused`
and the one report line `refused at step <n>: <reason>`. A refusal does nothing after the failed step, so a refusal
before step 5 leaves `main` untouched on both sides. When step 7 passes, the status is `landed` and the first line
is `landed <subject of the head> <short>, CI passed on the branch and on main`. Otherwise the status is `landed-red`,
the first line is `landed-red <subject of the head> <short>, CI passed on the branch; <reason>`, with the reason of
the CI wait or `the CI of main is unknown: <error>` when `gh` fails, and `land` reverts nothing. A failed step 9 and each failed check of step 10 add a line
`check failed: <what>`, such as `check failed: sweep <branch>: <error>`, and do not change the status. `landed` exits 0; `landed-red` and `refused` exit 1.

`land` never squashes, never merges through a pull request and never force-pushes: the commits of the branch reach
`main` as they are. It lands one change, and starts no review and no judge. Each step is safe to repeat, so `workflows
resume <run-id>` of a land run that stopped at any step ends in the same state.

## Sessions

The research, plan, implement, review and judge sessions use the roles `researcher`, `planner`, `implementer`,
`reviewer` and `judge`. The `summarizer` sessions, which compress the notes of the run memory, use the role
`summarizer`. A role takes its model and thinking level from `--agents` and the agents tables, else from the project
agent: the Pi default model and thinking level. The package table gives `summarizer` the thinking level `low` and
nothing else. See [Roles](#roles). Every session gets the same tools, and the same instructions: the session is not the
user's main agent. Like every workflow script, `ship` and `campaign` read the scripts, prompts and agents table of the
package and of the project folder `.workflows/` of the current directory, also when `--repo` selects another
repository. See [Workflow scripts](#workflow-scripts). `{ "planner": { "model": "openai/gpt-5" } }` in
`.workflows/agents.json`, for example, gives the planner another model.

Sessions are children of harness's children library in the harness host of the run's project, and use the host's
providers and credentials: Pi's, from `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), including the providers that Pi
extension packages register, such as `cursor`. Their system prompt has the `AGENTS.md` instructions and skills that Pi
loads for the worktree, as harness gives its children: project skills only in a project that Pi trusts.

The tools are `read`, `grep`, `find`, `ls`, `write`, `edit` and `bash`, harness's `subagent`, `todo` and `codemode` tools, and the tools of
the packages in Pi's settings that declare `"piDurable": { "extensions": [...] }`, such as pi-ipython and pi-rlm. The
host loads these packages once, when it starts, so a package installed later reaches the runs of a project after its
host restarts. A session of a run gets none of harness's store tools (`thread`, `rule` and `parley`),
in its model tools or in `codemode`. A subagent that a session spawns is a child of that session.

A session of a run that a command starts is at depth 1 of harness's tree of children, in the tree
`workflows:<root-run-id>`, and its subagents at depth 2, the deepest that harness allows. A task that a conversation
of the host drives puts its new sessions under that conversation instead, see
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

`list`, `resume`, `wait`, `stop`, `show`, `log`, `attach`, `save`, `sweep`, `check` and `outline` are commands,
`COMMAND_NAMES` of `src/tool.ts`, so no script of these names can run. A project script with one of these names fails
every command that loads the scripts of the project, also `workflows` and `outline --json`, with `workflows:
<project>/scripts/<name>.js has the name of the command <name>; rename the script`, and exit 1. Bad usage of a command
prints `workflows: <error>`, then `usage:` and the usage line of that command, such as `usage: workflows show (<run-id>
[--agents] [--json] | [<run-id>] --pick)`, and exits 2.

`workflows --version` prints the version of the package, from its `package.json`, and exits 0. It ignores any other
argument.

The project folder is `.workflows/` at the root of the current directory's Git repository, or in the current
directory outside a repository. It has the shape of the script side of the package, `workflows/` of the package: it
can hold `scripts/*.js`, `prompts/*.md` and `agents.json`. A project file adds to the package files, and replaces
the package file of the same name in the same folder. Only the package has `lib/`. The `agents.json` tables do not
replace each other: they merge by role name and field, as [Roles](#roles) says.

`workflows` without arguments prints one line `<name>: <description>` for each script, or `<name>` for a script
without `meta.description`.

### `meta`

A script declares its command line, and optionally its outline, in `export const meta = { ... }`, after its leading
comments and before any other code. `meta` is an object literal. The command evaluates it alone, in the sandbox, and
does not run the script. The evaluation has no time limit, but it stops after 1,000 interrupt polls of the sandbox,
so a `meta` that computes without end fails with
`workflows: <name>: meta: Execution exceeded its interrupt budget of 1000`. The script runs without `export`, so it
can read `meta`. A script without `meta` takes no arguments.

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

- `description` is one line for `workflows` and `--help`, like the `description` in the frontmatter of the
  prompts. It is a string.
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
  is checked out at <path>` before Git makes anything. The worktree is `<parent>/.worktrees/<name>/<run-id>`, where `<parent>` is the folder that holds the
  repository and `<name>` is the repository folder's name: `~/code/app` gets `~/code/.worktrees/app/<run-id>`, and the
  clone of a GitHub repository gets `<run-directory>/.worktrees/repository/<run-id>`. Git creates the worktree with
  `git worktree add`. At the end, the run names the branch: see
  [Branch name](#branch-name).

  Each task of the run checks the worktree before the script runs, and changes nothing when it refuses. The run then
  fails with one of these lines:
  - `run <run-id>: <path> exists, but Git cannot read it as a worktree of <repository>: move or repair the folder,
    then resume`, when the folder is not its own top level, or its Git common directory is not the repository's. The
    folder and its files stay.
  - `run <run-id>: the worktree <path> is on <branch | a detached HEAD>, not on <expected>: check out <expected> in
    it, then resume`. The worktree may also be on the name that the run gave the branch, when the branch `<expected>`
    is gone and the reflog of the current branch records the rename from `<expected>`.
  - `run <run-id>: branch <branch> does not exist, and only the first task of a run makes it from <start>: restore
    the branch, then resume`, when the folder and the branch are both missing. Only the first task of the run, also
    when its phase runs again, makes the branch from the start commit.

  When the folder is missing, the task runs `git worktree prune`, which removes only the registrations whose folder is
  gone, and adds the worktree again on the branch. It removes no folder.
- `repo: true` adds `--repo <path>`, and shows `[--repo <repository>]` in the usage line. `<path>` is relative to the
  current directory and must be the top level of a local Git repository. The run's directory is that top level in
  place of the current directory, so `sh`, `ok`, the sessions and the child runs work in that checkout, as
  `cd <path> && workflows <wf>` would. There is no clone and no new worktree. Any other value fails with
  `--repo <value> is not the top level of a Git repository` and the usage line of the script, and exits 2, before the
  run starts. The project folder `.workflows/`, the files of the arguments, `--prompts` and the harness project stay
  those of the current directory. `judge` and `thermoloop` have it. `repo` is then a reserved argument name. A `repo`
  that is not a boolean fails with `meta.repo is not a boolean`, and `repo: true` with `worktree: true` fails with
  `meta.repo is for a script without meta.worktree`.
- `exit` maps `result.status` to the exit code. A script declares each status that it returns, also the ones that exit
  0. A code is an integer from 0 to 255: another code fails with `meta.exit.<status> is <code>, not an exit code from 0
  to 255`. The codes 2 (usage), 3 (waiting), 4 (a run that the command can never follow) and 130 (Ctrl+C or aborted) are the command's own, and fail
  with `meta.exit.<status> is <code>, which the command reserves`. A status that `exit` does not declare exits 1, and a
  result without `status` exits 0. The status `waiting` always exits 3, whatever `exit` says. See [Input](#input).
- `outline` is the map of the script before a run: an array of the steps that a user sees in the progress of the
  script, in order. A step is `{ kind: "agent", role, label }`, a turn of the role `role`; `{ kind: "run", workflow,
  label }`, a child run of the workflow `workflow`; or `{ kind: "loop", label, steps }`, steps that repeat, such as
  review rounds or the items of a campaign. `steps` has at least one step, and loops can nest. `role`, `workflow` and
  `label` are non-empty strings with no line break, and a step has no other field. A child run whose phases show as
  steps of the caller gives those steps in place of one `run` step, as `rpi` and `thermoloop` do in `ship`:

  ```js
  outline: [
    { kind: "agent", role: "researcher", label: "research" },
    { kind: "agent", role: "planner", label: "plan" },
    { kind: "run", workflow: "implement", label: "implement" },
    {
      kind: "loop",
      label: "review, in rounds",
      steps: [
        { kind: "agent", role: "reviewer", label: "review" },
        { kind: "run", workflow: "implement", label: "fix" },
      ],
    },
    { kind: "run", workflow: "judge", label: "judge" },
  ],
  ```

  A bad outline fails with `meta.outline<pointer> <problem>`, where `<pointer>` is the JSON pointer of the wrong
  value, such as `meta.outline/0/kind must be agent, run or loop`. The problems are `is not an array of steps`, `is not
  a step`, `must be agent, run or loop`, `must be a non-empty line`, `must have at least one step` and `is not an
  outline field`. A run does not save the outline in its input. `workflows outline` prints it, and
  `workflows outline --json` gives it with the rest of the checked `meta`: see [Outline](#outline).

Every script also takes `--prompts <folder>`, as `ship` does, `--agents <name>=<provider>/<id>:<thinking>,...`, the
run layer of the roles (see [Roles](#roles)), `--serves <item-id | parley-slug>`, what the run builds (see
[Serves](#serves)), `--background`, `--json` and `--help`. These flag names, and the options that a placement adds,
are reserved argument names: `meta.args.<name>` with one of them fails with `meta.args.<name> is a reserved name`.
`workflows <wf> --help` prints
the usage line, built from `meta`, and `meta.description` when the script has one, and exits 0. Any other flag is bad usage. Bad usage prints
`workflows: <error>` and the usage line of the script, and exits 2. A bad `meta` fails with
`workflows: <name>: <problem>` and exits 1.

Before the run starts, the command scans the script for prompt calls, `prompts.<name>(`. A name without a template
fails with `<name> uses prompts.<prompt>, which has no template`. Other text such as `prompts.diff` in a path is not a
call, and a dynamic call such as `prompts[name]()` is not scanned.

`workflows check <wf>` reads and checks `meta`, the scanned prompts and the agents tables. It checks each object
literal with a string `provider` or `model`, with the role of its `as` (default `default`) in the agents table for
the field that it leaves out, against Pi's model registry: Pi's
`models.json` and the providers that Pi and its packages register. Only an object literal that the script passes to
`session(...)` or `agent(...)` counts, without its inner objects. A model that the registry does not have fails with
`<name> uses the model <provider>/<id>, which Pi's model registry does not have`. A field whose value is not a string
literal, or an object with a spread, is checked when the session opens. A regular expression literal is skipped, so a
quote in it hides no later field. `check` also checks every model of the merged agents table, and fails with
`agents.json gives <role> the model <provider>/<id>, which Pi's model registry does not have`. A role name without an
entry passes. `check` also fails when a `run` step of `meta.outline`, at any depth, names a workflow that the bundle
(the scripts of the package and of `.workflows/scripts`) does not have, with `<name>: meta.outline<pointer> names no
workflow <workflow>`, where `<pointer>` is the pointer of the `workflow` field. `check` prints `ok <name>` and exits
0, or prints the first problem and exits 1. It starts no run and writes nothing.

### Branch name

A run with a worktree of its own whose result has a string `subject` names its branch: a shipped `ship` returns the
commit subject, and a done `campaign` the subject of the last split. A child run without a worktree of its own, such
as each item of a campaign, names no branch. The name is `subject` as a branch name: the Conventional Commit type,
`/`, then the lowercase words of the description joined with `-`, at most 48 characters cut at a word end. A subject
without a type gives the words alone. `feat(pi): Show the runs` gives `feat/show-the-runs`, and `Fix the README typo`
gives `fix-the-readme-typo`. A subject without a letter or digit keeps `<wf>/<run-id>`.
A script can also set `change` in its result: `thermoloop` and `judge` set the change of the checkout that they ran
in. A run with a worktree of its own gets `change` from the engine, which replaces the `change` of the script.

`prepareWorktree` of `src/launch/worktree.ts` is the one place that builds the default branch `<wf>/<run-id>`, and
it marks that worktree with `renames: true` in the saved input. Only such a worktree renames its branch: a worktree on
a `--branch` branch, or on the branch of `checkout`, keeps its branch, also on a detached HEAD, and its report gets
`branch <branch>`. The run renames `<wf>/<run-id>` to the name, and adds `-2`, `-3` and so on when the name exists. It
renames only when the worktree is on `<wf>/<run-id>`, so a repeat after the rename keeps the branch it renamed to. The
report gets the last line `branch <branch>`. A name that Git refuses, such as `docs/typo` when a branch `docs` exists, keeps
`<wf>/<run-id>`, and the last line is `branch <name> is in conflict with an existing branch; kept <wf>/<run-id>`.
A branch `<name>` that another process creates while the run renames keeps `<wf>/<run-id>`, with the last line `branch
<name> was created during the rename; kept <wf>/<run-id>`. A worktree on a detached HEAD keeps `<wf>/<run-id>` in
`change`, with the last line `the worktree is on a detached HEAD; kept <wf>/<run-id>`.

Every result object of a run with a worktree of its own gets `change: { repository, branch }`, except a result that
waits for an answer. `repository` is the main checkout of the repository, the first entry of `git worktree list`,
also when the run started in a linked worktree. `branch` is the branch that the worktree ends on: after the rename
above for a result with a `subject`, else the branch of the worktree. A result without a `subject` gets no report line.
A child run without a worktree of its own gets no `change` from the engine: its caller owns the change.

`--branch <name>` puts the worktree on the new branch `<name>` in place of `<wf>/<run-id>`, from the start of the run.
A value that is not a valid branch name fails before the run starts with `--branch <name> is not a valid branch name`,
and a branch that exists with `--branch <name> exists`.

### Output

The command prints `run <run-id>` on stdout, then each `phase` and `log` line on stderr when the script's next call
runs, or when the script ends. The script runs in the host, which saves these lines in the project store, and the
command reads them from the store file about every 0.5 s. A read that fails prints `warning: cannot read the progress
of run <run-id>: <error>` on stderr once for each series of failed reads, also with `--json`; the next good read prints
the lines that it missed. See [Progress](#progress). When the script returns a result with `report`, a list of lines,
the command prints those lines on stdout. Otherwise it prints the return value: a string as it is, and any other value
as JSON. The exit code comes from `meta.exit`. A result object can have other fields, but `status`, `subject`, `runId`
and `question` must be strings, `report` an array of strings, `score` a number and `change` an object of the strings
`repository` and `branch`: a result with a bad field
fails the run with `the script result has a bad field: <path> <problem>`, such as `/report/1 must be string`. A run that
waits for an answer to `input(question)` prints the question and exits 3. When stdin and stderr are terminals, and
without `--json` or `--background`, the command asks the question in place of the exit: it reads one line on the
terminal and continues the run with it as the answer. See [Input](#input). With `--json`, stdout gets one JSON outcome
line in place of the lines. See [JSON output](#json-output).

A script that throws, or a call in it that fails, stops the run: the command prints `failed <title>: <error>` and
`continue with: workflows resume <run-id>` on stderr, and exits 1.

### Progress

The `phase` and `log` lines of a run make a tree of steps. Each `phase` line is a step of its run, and the step before
it in the same run is done. Each `log` line is under the current step of its run, or at the level of its run before
the first step. A child run is under the step of its caller that is current when it starts, indented by 2, also when
it has no line of its own. When the caller has no step then, the child run moves under the caller's next step. The
command draws the tree on stderr in one of three ways:

- On a terminal, the command draws the tree again in place at each change. A step is `◉` while it runs, `✓` when it
  is done, `✗` when its run failed or was orphaned, and `·` when its run was aborted. A step that ended ends with two spaces and its duration, such
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
the [Pi widget](#background-runs-in-pi) and `show --pick` show it.

When the run ends, the steps that still run become `✓` when the run is `done` or `waiting`, `·` when it was
`aborted`, and `✗` when it `failed` or was `orphaned`. The end event of an aborted run is saved with `aborted: true`,
so `show` and a later command show its steps as `·` too; an end event of an earlier version with `stopped` is not
valid, and the commands leave it out. A command that Ctrl+C detaches leaves them as they are. On a terminal and with `--json`, the tree draws once
more then. A command that follows a run shows only the lines that come after it starts or reaches the run. `<title>`
is the subject of the first `text` argument, or else the file name without `.js`, the workflow name, or `stdin`. The
run's task ends as failed, and its saved calls stay in the project store for the resume. `workflows log <run-id>` shows the failed call with the last lines of its error. See [Log](#log).

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

- The child's args are the defaults of its `meta.args`, then `args`, without `prompts`, `overlay`, `from` and
  `checkout`, with `meta.worktree` also without `repo`, `base` and `branch`, and with `meta.repo` also without `repo`.
  Before any worktree or child task exists, the declared args are checked against `meta.args` in declaration order,
  and the first problem fails the call with `run <name>: <arg> <problem>`: a `required` arg without a value
  `is missing`, and a value of the wrong type (`null` included) `must be a positive integer`, `must be a string` or
  `must be a boolean`. A `boolean` that is not given gets no `false`. An undeclared arg is not checked and reaches the
  script.
- With `meta.worktree` and `args.repo`, the child gets a new worktree on `<name>/<child-id>`, next to the repository as
  for `meta.worktree`, in
  the repository of `args.repo` from the caller's directory, at `args.base` (default `main`), and `args.start`.
  `args.branch` works as `--branch`. Without `args.repo`, or without `meta.worktree` and `meta.repo`, the child runs
  in the caller's directory, and `start` is an ordinary arg.
  With `meta.worktree`, a `repo`, `base`, `branch` or `start` that is not a string fails the call with
  `run <name>: <key> must be a string`.
- With `meta.repo` and `args.repo`, the child runs at the top level of the local repository of `args.repo`, resolved
  from the caller's directory, as `--repo` places a root run. A `repo` that is not a string fails the call with
  `run <name>: repo must be a string`, and a path that is not the top level of a Git repository fails it with
  `run <name>: repo <value> is not the top level of a Git repository`.
- Without `meta.worktree`, `args.checkout` names an existing branch of the repository of the child's directory: the
  caller's directory, or the repository of `args.repo` with `meta.repo`. It is not an arg: the child runs in a new
  worktree on that branch, next to the repository as for `meta.worktree`, and `start` stays an ordinary arg.
  `checkout` needs `start`, the commit that the change on the branch starts from: a `start` that is not a string fails
  the call with `run <name>: checkout needs start as a string`. A branch that does not exist fails the call with
  `run <name>: no branch <branch>`, and `checkout` fails the call for a script with `meta.worktree`. `checkout` is a
  reserved argument name.
- `args.prompts` maps prompt names to template texts. Each text, without frontmatter and the last `$@`, replaces that
  prompt in the child run only. A name with no prompt fails the call.
- `args.overlay` maps paths to texts or `null`. A value of another shape fails the call with
  `run <name>: overlay is not an object of path to text or null`. `overlay` is a reserved argument name.
  - A key `prompts/<prompt>.md` replaces that prompt, as `args.prompts` does, or removes it with `null`. A key for a
    prompt that the caller's bundle does not have fails the call with `run <name>: no prompt <prompt>`. A call of a
    removed prompt fails as a call of an unknown name does. When `args.prompts` and `args.overlay` replace the same prompt, the text of `overlay` wins.
  - Every other key is a file that the sessions of the child run see in place of the disk: the run opens each session
    with these files as `overlay` in its spec of the children library, so the subagents of the session see them too.
    A string replaces the file, and `null` removes it. A relative key is relative to the session's directory, the
    run's worktree; an absolute key stays as it is. The files on disk do not change. The child run saves the files
    as `overlay` in its input, over the files of the caller run: the caller's keys are inherited, and the child's own
    keys win. Keys compare as written, so a relative key and the same file as an absolute key are two keys.
  - A run without files in its overlay saves no `overlay` field, and its sessions open with no overlay.
- `args.from` names a saved root run of the project store, of any workflow and any status. The child run gets the
  prompts and agents table of the saved bundle of the last task of that run in place of the caller's; the scripts and
  the lib stay the caller's. `args.prompts` and `args.overlay` apply on top of them. A run ID that is not a root run
  of the store, such as a child run ID, fails the call with `run <name>: no run <id>`, and a `from` that is not a
  string fails it with `run <name>: from is not a run ID`. `from` is a reserved argument name. The caller's run layer
  of `--agents` stays above the agents table of that run.
- The child run gets the caller's saved scripts, prompts and agents table, or those of `args.from`, with the replacements
  of `args.prompts` and `args.overlay`, the caller's file overlay, and the caller's run layer of `--agents`. So every
  child run of a child run gets them too.

`run()` returns the child's result, with `runId`, the child run ID, added to an object result. A failed child run
fails the call with `child run <id> failed: <error>`, where `<id>` is the deepest child run that failed, and the child's task ends as failed. A child run that was aborted or orphaned fails the call with `child run <id> aborted: <reason>` or `child run <id> orphaned: <reason>`. A caller that fails aborts
its child runs that are still running. A resume of the caller continues the same child run, with the same run ID and
run directory, also after a failed call, an abort or an interruption, and repeats no call that the child run saved. A
child run that ended without a result continues in a new task, with the agents table of the caller's current task. A
child run of `args.from` keeps its saved table.

### The script API

A script is the body of an async function: top-level `await` and `return` work. Each call below is a durable call,
except `phase`, `log`, `args`, `cwd`, `workflowsCommand` and `prompts`. The calls are async: a call that runs
something returns a promise, so a script writes `await` before it, as in `JSON.parse(await sh(cmd))`. `session(name)`
returns its session at once, and `phase`, `log` and `title` need no `await`.

| Global | Meaning |
|---|---|
| `args` | The argument values of `meta.args`, and `start` with `worktree: true` |
| `runId`, `runDir` | The run ID and the run directory. A script that `run()` starts gets its own values |
| `cwd` | The directory where `sh` and `ok` run: the run's worktree, the repository of `--repo`, the caller's directory, or the directory of the command |
| `workflowsCommand` | The `workflows` command of this package as one shell-quoted string, run with the Node of the host and not found on `PATH`, as in ``sh(`${workflowsCommand} --version`)`` |
| `await agent(prompt, { as, provider, model, thinking, schema, settle })` | One turn in a new session of the role `as` (default `default`), with the model of [Roles](#roles). Returns the reply text, or the answer with `schema`. With `settle: true`, a failed turn returns `{ error }` with its message, and a resume returns the same `{ error }`. The prompt is the `key` of its session |
| `session(name)`, `session({ as, provider, model, thinking, key })` | A new session of the role `name` or `as` (default `default`), with the model of [Roles](#roles), returned at once. `await <session>.ask(prompt, { schema, settle })` is one turn in it, with `schema` and `settle` as for `agent`. `key`, a string, tells apart the sessions of the same options |
| `await sh(cmd, { settle })` | Runs `sh -c <cmd>` in the current directory of the start, with no stdin: a command that reads stdin reads end of file. Returns stdout without the last newline, and throws on a nonzero exit code. The error is `sh exited with <code>: <cmd>`, then a newline and the stderr when it is not empty. With an array `[program, ...arguments]`, runs the program with no shell, and the error is `<program> <first argument> failed: <output>`, with the stdout and the stderr as the output. In the error, output of more than 4096 UTF-8 bytes is cut to a note `[… <n> bytes cut; workflows log <root-run-id> <call> shows the call]`, a newline and the longest end of the output that fits, from a line start when that end has one, else from a character, together at most 4096 bytes. The record of a failed call keeps its exit code, stdout and stderr, as [Saved inputs and resume](#saved-inputs-and-resume) says. With `settle: true`, a failure returns `{ error }` with that message, and a resume returns the same `{ error }` |
| `await ok(cmd)` | Runs `cmd` as `sh` does. Returns true when the exit code is 0 |
| `await run(name, args)` | Runs the script `name` of `scripts/` in the package or the project as a child run and returns its result. See [Child runs](#child-runs) |
| `await pastRuns(workflow, { runs, limit })` | The completed root runs of `workflow`, or of every workflow for `null`, in the project store. See [Past runs](#past-runs) |
| `await harness(request)` | Sends one request to the harness host of the run's project and returns its reply. See [Harness requests](#harness-requests) |
| `await todo.add(text)` | Adds a todo with the state `open` and the next ID to the list of the run, and returns it, `{ id, text, state }`. See [Todos](#todos) |
| `await todo.set(id, state, text)` | Sets the state of the todo `id` of the list of the run to `open`, `doing`, `done` or `dropped`, and its text when `text` is given, and returns the todo |
| `await todo.list()` | The todos of the list of the run, in ID order |
| `await input(question)` | Asks the user `question` as an ask of the project, and returns its answer: from `workflows resume <run-id> --answer <text>`, the `workflow` tool with `resume` and `answer`, or an answer of the ask elsewhere. Only a root run can ask. See [Input](#input) |
| `prompts.<name>(inputs)` | The instructions of `prompts/<name>.md`, then each non-empty input as a `## <name>` section |
| `phase(title)`, `log(text)` | Write one step, or one line under the current step, on stderr before the script's next call that runs |
| `title(text)` | Name the run `text` in `list`, `show` and the end lines, in place of the subject of its first `text` argument; the last call wins. `changeOf` calls it with the subject of the intent |

A call with an argument of the wrong type, such as a prompt that is not a string, a `sh` command that is not a string
or an array of strings, or a `prompts.<name>` input that is not a string, fails with
`<call> got bad arguments: <path> <problem>`, where `<call>` is `session`, `ask`, `sh`, `ok`, `run`, `pastRuns`, `todo`, `harness`, `input` or `prompt`, and
`<path>` points to the deepest wrong value in the arguments, such as `/0/1` for `sh(["git", 1])`.

#### Past runs

`pastRuns(workflow, { runs, limit })` returns the root runs of the script `workflow`, or of every script when
`workflow` is `null`, in the project store whose last task completed with a result that does not wait for an answer,
newest first by run ID. Child runs, waiting runs and runs in progress are not in the list. It reads the tasks of
`workflows.run` through the host, at the current task version and at earlier ones, and skips a task whose saved input
does not have the fields below. Each run is an object:

| Field | Value |
|---|---|
| `runId` | The run ID |
| `item` | The `item` arg of the run, or `null` |
| `cwd` | The directory that the run ran in: the top level of the repository of `--repo`, else the caller's directory |
| `repository`, `start` | The repository and the start commit of the run's worktree, or `null` |
| `prompts` | The saved template texts, by prompt name |
| `serves` | What the run serves, `{ "item": <id> }` or `{ "parley": "<slug>" }`, or `null` when its start named nothing or its input has another shape |
| `result` | The result of the run |

`runs`, an array of run IDs, gives those runs in that order: an ID that is not a completed root run of `workflow` fails
the call with `no completed <workflow> run <id>`, or with `no completed run <id>` when `workflow` is `null`. Without `runs`, `limit`, an integer of 0 or more, gives at most that
many runs; without `limit`, it gives all of them. Another option fails with `pastRuns got bad arguments`. The call
saves its result, so a resume returns the same list and does not read the store again.

#### Harness requests

`harness(request)` sends one request to the harness host of the run's project, with no start of a host, and returns
the reply of the host. The request is one of:

- `{ type: "item", action: "read", id }`: the item `id` with its edges.
- `{ type: "item", action: "link", from, kind, to }`: writes the edge, and returns it.
- `{ type: "item", action: "set", id, state }`: sets the state of the item `id`, and returns the item.
- `{ type: "tree" }`: the nodes of the tree of the project, `{ nodes }`.

The call adds `caller: workflows:<run-id>` to a `link` and a `set`. Another request fails with
`harness got bad arguments: <path> <problem>`. An error of the host fails the call with its message, and no host
fails it with `no harness host runs for <project>`. The call is of the kind `harness`, with the request as its args,
and saves the reply, so a resume returns it and does not send the request again.

#### Todos

`todo.add`, `todo.set` and `todo.list` read and change the list of todos of the run, with the rules of harness's
`todo` request. A todo is `{ id, text, state }`: its ID is its place in the list (1, 2, 3 and so on), and its state is
`open`, `doing`, `done` or `dropped`.

- The list of a run is the list of the first task of the run: the oldest `workflows.run` task whose saved input has
  the run ID. For a root run, this is the task of the key `wf:<run-id>#1`, so `harness todo --task wf:<run-id>#1` gives
  the same list. Every later task of the run uses the same list: the task of a resume after a failure or an abort, of
  a `resume --answer`, and the new child task of a child run that ended without completing.
- A child run has its own list: the list of its own first task. A `todo` call of a child run does not change the list
  of its caller.
- The `todo` tool of a session keeps the list of the session's conversation, which is another list.
- Each verb is a call of the kind `todo`, with the args `{ action: "add", text }`, `{ action: "set", id, state, text }`
  (`text` only when it is given) or `{ action: "list" }`. A resume returns the saved result. `add` and `set` change the
  list in the commit that saves their result, so a stop cannot add a todo that the run does not know, and a resume never
  adds a todo twice.
- An ID that is not an integer from 1, a state that is not one of the four, or a text that is not a string fails with
  `todo got bad arguments: <path> <problem>`, where `/0` is the text of `add` or the ID of `set`, `/1` the state, and
  `/2` the text of `set`. An empty text fails with `The text of a todo is empty`, and an unknown ID with
  `Unknown todo: <id>`. A call that fails does not change the list and saves no result.

#### The script lib

Every script also gets these helpers of the files of `workflows/lib/`, which the run puts after the calls above. The run
gives a script only the helpers that `workflows/script.d.ts` declares: the other names of the lib files are not globals
of a script. The helpers use only the calls above. A lib file only declares: it runs no code when it loads, so the order
of the files does not change the result. A run saves the lib with its scripts and prompts, so a resume uses the lib that
the run started with. A script's own declaration of the same name takes their place.

| Global | Meaning |
|---|---|
| `await parallel(thunks)` | Runs the functions at once and returns their results. Give each `session` of a function a different `key` |
| `await pipeline(items, ...stages)` | Sends each item through the stages in order, and the items at once. Give each `session` of a stage a different `key` |
| `subjectOf(text)` | The first non-empty line of `text`, without leading `#` |
| `oneLine(text)` | `text` with each whitespace run made one space, trimmed |
| `await memory(ref)` | The run memory of `ref`, `{ path, plain, item }`: the OptMem store `path`, through `$HOME/.optmem/memo` with `MEMORY_DIR` set to `path`, or with `plain` the file `<path>/notes.txt` of `#<k> <note>` lines, with no summaries, and in both stores `<path>/notes.keys`, the key `<run-id>/<note>.<n>` of each note, its stored line and the count of that line among the adds of this execution, from 1, whose line is `<k>` in the plain store; an add whose key is there adds no note. Without `ref.path`, opens the store `<runDir>/memory` with `memo init` and `memo config PART_CHARS=100000`, or, without `memo`, the plain store, and logs the install command of OptMem. `.ref` goes to a child run. `.note(author, round, notes)` adds each note, as the line `[item <item> ]<author>[ r<round>]: <note>`, with its whitespace collapsed, empty ones left out, and words cut from its end above 280 UTF-8 bytes, then, in an OptMem store, answers each compression that `memo` asks for with a `summarizer` turn and `memo nap`. `memo` asks only when the last non-empty line of its output is the whole line `Run: <memo> nap <lo>-<hi> "<your line>"`: the prompt runs from the last line before it that starts with `Compress memories #`, so notes that hold these words ask nothing. A last line of that form with no such line before it fails with `memo asked for a compression without its prompt: <last line>`, and the 65th request in a row fails with `memo still asks for compressions after 64 summaries`. `.text` is a promise of the notes, one `#<k> <note>` line each. `.finish(item, result)` gives `result` as it is when `ref.path` was given, else `result` with `lessons` and the report line `  lesson <cue>: <lesson> (<evidence>)` for each lesson after the other lines: `[]` with no turn when there are no notes, else the lessons of one `summarizer` turn on the `harvest` prompt with `item` and `result` without its `report` and `memory` keys at any depth, each `{ cue, lesson, evidence }` with its whitespace runs made one space. `.session(name)` is a session of the role `name` whose first `.ask(prompt, { schema })` starts with a `## memory` section of the notes, from `memo wake` in an OptMem store, and whose `.noted(round, prompt, rule)` adds `When you are done, answer with respond: text is <rule> Each note is one line of at most 280 bytes.`, asks for `{ text, notes }`, adds the notes under the role name, and returns the text |
| `await noteLines(notes)` | The `#<k> <note>` lines of `notes.text`, without empty lines |
| `await commitAll(message)` | Stages every change, and commits it as `message` when something is staged, with the check and the commit in one command, so that a repeat makes no second commit. The shell runs the commit with `exec`, so a stop of the run also stops the commit |
| `await squash(start, message, subject)` | Squashes the commits since `start` into one commit with `message`, logs `commit <short> <subject>` and returns the short head. When nothing changed since `start`, it makes no commit, logs `nothing to commit since <short>` and returns the short head. Safe to repeat: it is one command, so a repeat resets a squash commit that was made but not saved. The shell runs the commit in the background and kills it on `TERM`, so a stop of the run also stops the commit |
| `await commitChange(item, start, findings)` | Asks a new `implementer` session for the commit message of the change from `start` to `HEAD`, with the `commit` prompt and the inputs `item`, `base`, `head` and `findings`, the lines of `findings` (default `[]`) joined with newlines, squashes the change into one commit with it, and returns `{ head, subject, warnings }`, `head` the short head, `subject` the commit subject, and `warnings` the lines that it logged for a script's report. When the turn fails or gives an empty subject, the message is the subject of `item`. The turn has `settle: true`: a failed turn logs `commit message failed on <subject of item>: <error>, so the message is the subject of the item`, and `warnings` is that line; else `warnings` is `[]` |
| `await judgeCommit(item, start, committed)` | Runs the child run `judge` with `item` and `start`, and returns `head` and `subject` of `committed`, the result of `commitChange`, with the judge fields `status`, `score`, `answers`, `findings` and `divergence`. A failed judge fails the caller |
| `await writePatch(path, from)` | Writes `git diff --binary` from `from` to `HEAD` to the file `path`, and returns `path` |
| `await prOf(ref, fields, { settle })` | The pull request of `ref` with the JSON `fields`, from `gh pr view`. It fails when `gh` fails, or with `settle` returns `{ error }`, as `sh` does |
| `prBranch(pr)` | The local branch of the pull request `pr`: `pr/<number>` when `isCrossRepository` is true, else `headRefName`. `thermoloop`, `judge` and `land` use this name |
| `await isBranch(name, dir)` | True when `name` is a local branch of the repository of `dir`, default the current directory |
| `await checkoutChange()` | `{ repository, branch }` of the current checkout: the main checkout of its repository, the first entry of `git worktree list`, and its branch. Undefined on a detached HEAD |
| `await changeOf(args, { wip })` | `{ start, intent, checkout, dirty }` of the change of a script's `args`. With `args.start`, it is `args.start` and `args.item`, not dirty, with no Git step. Else it is the change that `args.change` points at from `args.base`, with the rules of [Thermoloop](#thermoloop), and it calls `title` with the subject of the intent: `start` is the start commit, `intent` is `args.item` or the pull request or the commit messages, `checkout` is the branch of a change that ends on a branch other than the current one, and `dirty` says that the current checkout has changes that are not committed. With `wip`, a change in the current checkout commits them first as `wip`, and a change whose branch another worktree has with changes that are not committed fails |
| `await inCheckout(name, change, args)` | Runs the script `name` again as a child run with `args` and the `item` and `start` of the change: with `repo`, the worktree that has the branch of the change checked out, else with `checkout`, that branch, in a worktree of its own. Returns its result with the last report line `worktree <path>`, the worktree that has the branch |

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
Effects go through `sh` and `ok`. `Date`, `Date.now()` and `Math.random()` throw, also through `globalThis`, so that
a script makes the same calls each time it runs. The other `Math` functions work. The lock covers only the names
`Date`, `Math` and `globalThis` that a script uses: code that gets the real global object through `Function`, an
indirect `eval` or the `constructor` of a function gets the real `Date` and `Math.random`. pi-codemode freezes its
built-in globals before the prelude runs, so the prelude cannot replace them.

### Roles

A role is a name: `name` of `session(name)`, or `as` of `agent(..., { as })` and `session({ as })`, `default` when
the call gives none. Any name is a role. A role takes its model and thinking level from these layers, first layer
first:

1. The call: `provider`, `model` and `thinking` of `session(...)` or `agent(...)`.
2. The run: `--agents <name>=<provider>/<id>:<thinking>,...` of the command, or `args.agents` of the `workflow` tool.
3. `<repo>/.workflows/agents.json`, in the project folder.
4. `$XDG_CONFIG_HOME/workflows/agents.json`, or `~/.config/workflows/agents.json` without `XDG_CONFIG_HOME`.
5. `workflows/agents.json` of the package: `{ "summarizer": { "thinking": "low" } }`.
6. The project agent of harness: the Pi default model and thinking level.

```json
{
  "*": { "model": "anthropic/claude-opus-5-5" },
  "judge": { "model": "openai/gpt-5", "thinking": "high" }
}
```

A table is an object of role names, and `"*"` gives every name. Each entry has the optional fields `model`, as
`<provider>/<id>`, and `thinking`, a non-empty string. For each field, a table gives a role the field of its own
entry, else the field of `"*"`, and the first table that gives the field wins. So a repo `"*"` model wins over a user
entry of the role. A missing file is an empty table. A file that is not JSON, or an entry with another field or a bad
value, fails the command before the run starts with `<file>: <problem>`, such as
`<repo>/.workflows/agents.json: judge.model must be <provider>/<id>`. The command reads the tables when it starts a
run, and the run saves the merged table, with the run layer above the tables. `resume` reads the tables again when it
starts a new task of a run that ended: see [Saved inputs and resume](#saved-inputs-and-resume).

The value of `--agents` is a list of parts split on `,`, such as `*=anthropic/claude-opus-5-5:high,judge=:low`. A part
is `<name>=<value>`, split on its first `=`, and `*` is every role, as `"*"` of a table. The value splits on its last
`:` into the model, `<provider>/<id>`, and the thinking level; without a `:`, the whole value is the model. Each part
and each half is trimmed, and an empty half gives no field. The run layer takes each field as a table does. Thinking
level names are not checked here. A bad part is bad usage, exit 2, before the run starts:

- `--agents '<part>' must be <name>=<provider>/<id>:<thinking>`: a part without `=`, with an empty name, or with
  neither a model nor a thinking level.
- `--agents '<part>' has a model that is not <provider>/<id>`.
- `--agents '<part>' gives <name> again`: a name that an earlier part gave.

`agents` is a reserved argument name. `resume` and `check` take no `--agents`: a resume keeps the saved run layer.

A call can give `provider`, `model` and `thinking`. Each field that the call gives overrides the role, and the role
fills the rest. A session without a provider or a model from the call or the role takes the model of the project
agent of harness (Pi's default model), and without a thinking level it takes the project agent's level, cut to the
nearest level that the model has. Every session gets the same tools as the ship sessions, and the same instructions in
its system prompt: it is a session of a workflows run, not the user's main agent. A model that the host's model
registry does not have, or a `thinking` level that the model does not have, fails the `session` call, or the `ask`
call of a session that moves to it after a resume, with harness's error, such as `Unknown model: anthropic/nope`.

### Saved inputs and resume

Before the run starts, it saves the script, every `scripts/*.js` of the package and the project, the lib, the instructions
of every prompt, the merged agents table, the run layer of `--agents` apart from it (`agents`, `{}` without the
option), `serves` of `--serves` (none without the option), `item`, the absolute path of the `.md` file that the
positional text argument names (none for inline text, for stdin and in a child run), the args, the project folder of the
start (none in a child run) and the directory of the run: the current directory, or the repository of `--repo` with
`repo: true`. Resume and `run()` use these saved
inputs, so a later edit of a script or prompt, in the package or `.workflows/`, changes only new runs. The shared
instructions of the sessions are not saved: a resume uses the text of the loaded code.

A later edit of an `agents.json` changes new runs and the next resume. A resume that starts a new task of a run that
ended, also of a waiting run with `--answer`, reads the tables again, merges them under the saved run layer, and saves
the result as the agents table of the new task:

- The project table is `agents.json` of the project folder of the start, which the run saves: the folder of the
  directory where the start ran, also for a `repo: true` script started with `--repo`.
- The user table comes from the environment of the resume command. The `workflow` tool runs `resume` as a command
  too.
- A bad table fails the resume before any task starts, with `workflows: <file>: <problem>` and exit 1. With `--answer`,
  the ask keeps the answer, and the next resume continues the run.
- A task that has not ended keeps its table, also when its host starts it again.
- A child run that a resume of its caller starts again gets the agents table of the caller's new task. A child run of
  `args.from` keeps its saved table.
- Before each `ask` call that sends a turn, and not one that returns its saved result, the run resolves the role of the
  session again: the fields of its `session` call first, then the agents table of the current task, then the model and
  thinking level of the session for a field that neither gives. When the model or the thinking level is different,
  the session moves to them before the turn, and its `session` call record saves the new model. So to leave a failing
  model, edit a table and resume. A model that the host does not have, or a thinking level that the model does not
  have, fails the `ask` call with harness's error, such as `Unknown model: anthropic/nope`.

Resume runs the script again from the top. A call that succeeded before returns its saved result, and is not run
again. A call is known by its name, its arguments and its position among identical calls. The calls of `parallel` and
`pipeline` can start in another order at resume, so two identical calls there can swap their saved results: a session
in a branch needs its own `key`, and an `agent` call its own prompt. A turn that was in progress
continues in its session. A command that was in progress runs again, so commands must be safe to repeat. Each call
records its kind, the arguments of its kind, its phase and its start time when it starts, and its `end` when it ends:
`{ "kind": "done", "at", "result" }`, `{ "kind": "failed", "at", "error" }`, or `{ "kind": "cancelled", "at" }`. A
call without `end` has not ended. The arguments of each kind are: `session` `{ "profile", "provider"?, "model"?,
"thinking"?, "key"? }` (`key` is the first 16 hex characters of the sha256 of the key that the script gives, the prompt of an `agent` call), `ask` `{ "conversation", "prompt", "schema", "settle"? }` (`schema` is `null` without one), `sh`
`{ "cmd", "check", "settle"? }`, `ok` `{ "cmd", "check" }`, `run` `{ "name", "args" }`, `input` `{ "question" }`, `pastRuns` `{ "workflow", "options" }`, and
`todo` `{ "action": "add", "text" }`, `{ "action": "set", "id", "state", "text"? }` or `{ "action": "list" }`, and
`harness` the request, as in [Harness requests](#harness-requests).
`CALL_RECORD` of `src/run/calls.ts` is the schema of a record, one member for each kind. It also records the task that
started it, for a `session` call its conversation and the model of the session, `{ "provider", "model",
"thinking"? }`, which a move of the session before a turn changes, for a `sh` call that failed with a nonzero exit code, with `settle` or not, `output`, `{ "code", "stdout", "stderr" }`, with the
last 1 MiB (1048576 UTF-8 bytes) of each stream (a longer stream is cut to a note `[… <n> bytes cut]`, a newline and
its end, together at most 1 MiB), which the call drops when it runs again, and for a `run` call the run ID of its child run before the child's run directory exists, so a rerun
after a crash uses the same run ID and directory. `show`, `log` and `resume` read only the records that match the
schema, so they skip the calls that an earlier version saved: `show` of such a run shows its steps with no calls. A call that fails saves no
result unless `settle`, so every call that failed runs again, also one that the script caught. `settle` is `true` when
present: an `ask` or `sh` call with `settle` saves its failure as the result `{ "error" }`, and a resume returns it. A
call that the end of its script cancelled saves no result and runs again, also with `settle`. The
saved results stay in the project store also after the run fails. `phase` and `log` lines are progress, not saved
results. A resume prints the phase line of the first call that runs, and the lines after it. A call that returns a saved result drops the `log`
lines before it, and keeps the last `phase` line waiting for the next call that runs.

An `input` call whose ask has an answer saves the answer as its result, so a later resume returns it, and does not
wait again.

When the script ends, by its result or by an error, the calls that it did not wait for are cancelled: a `sh` or `ok`
command is killed, a `run()` call stops waiting for its child run, and an ask stops waiting for its turn. The script's
task ends only once they stopped, so no call goes on after the run ended. A cancelled call records the end
`cancelled`, with the time of the cancel and no result, so `show` shows it as `cancelled`, and it runs again on resume;
a call that a stop or a host stop cut records nothing more.

### Serves

`--serves <value>` names what a run builds, apart from the text of the run: a value of digits only is the ID of an
item, and any other value is the slug of a parley. A value that is neither, such as `Bad_Slug`, is bad usage:
`--serves <value> is not an item ID or a parley slug`. The run saves it in its input as `serves`, `{ "item": <id> }`
or `{ "parley": "<slug>" }`, the `ServesInput` of harness, and its child runs keep it. `list --json`
and `show --json` give it as `serves`; a run that names nothing has no `serves`.

Each task of a root run, the first one and each resume, checks it when it starts, through the `item read` and
`parley read` requests of harness to the host of its project, with the rule of harness for what an agent serves. An
item that the host does not know fails the run with `Unknown item: <id>`, and an item that is done or dropped with
`Item <id> is <state>: a run cannot serve it`. A parley that the host does not know fails it with `Unknown parley:
<slug>`, and a parley that is not open and not a contract with `Parley <slug> is <status>: a run cannot serve it`. So
a resume after the end of the item or the parley fails. After the check of an item, the task sends `item link` with
the caller `workflows:<run-id>` and the edge `run:<run-id> serves item:<id>`. The host writes the edge once, so each
resume sends it again with no change. A child run does not check or link. `land` of a run ID sets the item of the
run to `done` (see [Land](#land)). `serves` is a reserved argument name.

### Input

`input(question)` asks the user a question, as an ask of the project in the store of the harness host (see "Asks and
parleys" in the spec of harness). The ask has the asker `workflows:<run-id>` and the title `question`, with its
backticks removed and each run of two or more `*` cut to one, because a title is plain text; when that changes the
question, the ask keeps the question as it was as its `view`. The call record saves the ID of the ask as `ask`. The
first time the script reaches the call, the call writes the ask with an `ask round` request, the script stops once the
code that called `input` reaches its next `await`, and the run's task completes with the result
`{ "status": "waiting", "question", "report": [question] }`. Only an open `input` call makes a run wait: a script
that returns the status `waiting` itself fails with `the script returned the status waiting, but no input() call
waits`.
The command prints the question as the report line and exits 3, also with `wait` and with a resume without
`--answer`, when it cannot ask. A command can ask when stdin and stderr are terminals, without `--json` or
`--background`, and not after a Ctrl+C; `wait` never asks. Then the command reads one line on the terminal, with its
echo on stderr, and continues as `workflows resume <run-id> --answer <line>` does: it prints `run <run-id>` again and
follows the new task. A blank line is read again. A later `input` call asks again in the same way. Ctrl+C or the end
of input while the command reads prints `run <run-id> waits for an answer; continue with: workflows resume <run-id>
--answer <text>` on stderr and exits 130, and the run still waits. `list` and `show` give the status `waiting`, and
`show` lists the `input` call as `✗`, with the question as its label and the word `waiting`. A waiting run keeps its
sessions, as a failed run does.

The answer of the ask is the answer of the call. `workflows resume <run-id> --answer <text>` answers the open ask of the
run as the run itself: the answer `own`, with the words `[<text>]` and the label of the first line of `<text>` that is
not blank, as plain text. Then it starts a new task of the run with the same input and the agents tables of the resume
(see [Saved inputs and resume](#saved-inputs-and-resume)). The script runs again from the
top, and the call reads its ask: an answered ask returns its words, one on each line, or its label when it has no
words, and the call saves that as its result, so a later resume returns it and does not ask again. A dropped ask fails
the call with `the user dropped ask <n> of input "<question>"`. A later `input` call writes its own ask and waits in
the same way. A blank `--answer` prints `workflows: --answer needs a text that is not blank` and the usage line, and
exits 2. `--answer` for an ask that is not open prints `workflows: run <run-id>: ask <n> is <state>; continue with:
workflows resume <run-id>`, or `its input has no ask` in place of `ask <n> is <state>`, and exits 1, so the answer
that the run reads is the one that the ask has.

An answer that the ask gets elsewhere, in Orda, in Pi or with an `ask answer` request, reaches the run at its next
resume: the run is not resumed on its own. A resume without `--answer` of a waiting run reads the ask through the host.
When the ask is open, the resume asks or exits 3 as above. When it is answered or dropped, the resume starts a new task
of the run, which reads the ask. An ask that an answer reached elsewhere also has a delivery of harness for the asker,
which no one takes. An answered ask whose call the script no longer reaches, such as after a call that failed before
now succeeds, stays answered, and the run goes on to the call that it reaches.

While one `input` call waits, a second one that would wait, made before the script stops, fails the run with `the run
waits for an answer to: <question>`, the question of the first; the script cannot catch it. The `input` calls of one
execution decide one at a time whether they wait. A call that stopped after it wrote its ask and before its record
saved it uses the open ask of the run with the same title, so a resume writes no second ask. A blank question fails
the call with `input() needs a question that is not blank`.

`input()` in a child run fails the call at once with `input() in the child run <run-id>: only a root run can ask the
user`, and writes no ask.

## Resume

```sh
workflows resume <run-id> [--answer <text>]
```

`workflows resume` finds the workflow that the run saved and continues the run. A run that is gone, with no run
directory or no task, prints `workflows: no run <run-id> in <runs>` or `workflows: run <run-id> has no workflow`, and
exits 4 (`UNFOLLOWABLE_EXIT` of `src/tool.ts`). Every command that reads a saved run (`resume`, `wait`, `stop`, `show`, `log`, `save` and `attach`) does the same. A run of a workflow script continues
with the script that the run saved. The `project` file of the run directory names the run's project, so resume reaches
the host of that project from any directory.

Resume continues the pending work in the host. For a script, see [Saved inputs and resume](#saved-inputs-and-resume).
For `ship`, it uses the work item, repository, start commit, `workflows/scripts/ship.js`, prompts and round limit
that the run saved before it started, and the agents tables of the resume. `campaign` does the same with its goal and `workflows/scripts/campaign.js`: the split,
the splits, the shipped items, the fix rounds, the questions and the rundown are not run again. It does not read the work item file again, select or clone the
repository again, or create another branch. Answered turns are not sent to the model again. A turn that was in
progress is sent again.

Before resume starts a new task for a run with a worktree whose last task ended, it checks the worktree as each task
does (see `worktree: true` in [Meta](#meta)), with the rule that the new task is not the first task. When the check
refuses, it prints `workflows: <line>`, exits 1 and starts no task.

With `--background`, at any position before `--`, start and resume print `run <run-id>` once the host has the run's
task, and exit 0 without following it. With `--json`, they also print
`{"runId":"<run-id>","state":"running","follow":"started","workflow":"<workflow>","repository":"<repository>","posts":<posts>}`, where `<workflow>` is the name of the run's workflow,
as `workflows show` gives it, `<repository>` is the repository of the run's worktree, else the directory of the run, and `<posts>` is `true` when the end of the task posts
its outcome to the conversation of the command: the task has `notify`, and its driver is the driver of the command.
Else it is `false`, also for a task that has not ended and that another conversation drives. A Ctrl+C after the host accepted the task does not change this. The other commands
ignore `--background`. Follow such a run with `workflows wait <run-id>` or `workflows resume <run-id>`. A start with `--background` saves `notify` in the
input of the run. A resume that starts a new task saves `notify` only with `--background`, whatever the last task
had. A task saves `notify` only with a driver, so a task without a driver never has it. The driver of a task is the conversation of the host that the command runs in: `PI_SESSION_ID`, when
`HARNESS_PROJECT` is the project of the run and `PI_SESSION_ID` is a conversation ID of the host (a number). A start
saves it in the input of the run as `driver`. A resume that starts a new task saves the driver of the resume, or
no driver, whatever the last task had. A resume that follows a task that has not ended does not change it. See
[The `workflow` tool of the host](#the-workflow-tool-of-the-host) for what `notify` and the driver do.

A run has one live task at a time. When the run's last task has not ended, because it runs in the host or waits for
the host to start, resume follows that task and prints its outcome. When the host runs, resume prints the progress
lines of the task's current execution from its start. When no host runs, resume starts it and prints the progress
lines that come after. A host that starts continues the unfinished runs of its project on its own. When resume starts
a new task, it prints the progress lines of that task. Resume reads the run's tasks, their keys and the ask of the
open `input` call in one read of the store, then the state of that ask from the host. When two resumes of a run that ended run at the same time, there are two cases:

- The other resume had not started its task when this resume read the store. Both ask for the same key, and the
  first one gets the task. The other follows that task when it sent the same input, else it prints `workflows: run
  <run-id> was resumed by another command with another input: follow it with workflows wait <run-id>` and exits 1.
  Two resumes with `--answer` of a waiting run send the same input: when both read the ask open, both answer it, the
  last answer stays in the ask, and both follow the one task, which reads the answer that the ask has when it reaches
  the call. A resume that reads the ask after the other answered it gives the `ask <n> is answered` error of
  [Input](#input).
- The other resume had started its task. This resume acts as a resume that comes after the other one, and continues
  from that task by the rules of this section. It follows the task when it has not ended, prints its outcome when it
  ended with a result, and starts a new task when it ended without a result. When the task waits for an answer,
  `--answer` answers it, and without `--answer` the resume asks for the answer as below. With `--answer` and a task
  that does not wait, it gives the `does not wait for an answer` error below.

A run that fails with an error prints `failed <subject>: <error>` and `continue with: workflows resume <run-id>`, and
exits 1. Examples are a failing Git hook, or a model error that remains after Pi's retries. The run's task ends as
failed. Resume runs the script again in a new task of the same run, with the same input and the agents tables of the
resume: a failed Git step runs again, a failed turn is sent again in the same session, on the model of its role in the
tables of the resume, saved calls return their results, and child runs continue. The error of a failed Git command of the engine, and of a
failed `gh` call of `sweep` in its warning line, has the output of the command cut as the error of a failed `sh` call is, with no call in
the note. A run whose task ended in another way, such as an aborted or orphaned task, or one that pi-durable faulted, resumes in the same way. An ask whose answer
stopped for a reason other than its end, such as its length, fails its call, and a resume asks again. So does an ask
whose answer did not call `respond`. A resumed ask never returns the answer of another ask in its session.

A shipped, rejected, blocked or stopped run is final: resume prints the same result and exits with the same code. A waiting
run without `--answer` whose ask is open prints its question again and exits 3. When the command can ask, it reads the
answer on the terminal and continues the run with it, or prints the `waits for an answer` line and exits 130 when no
answer comes. A waiting run whose ask has an answer or was dropped continues in a new task. See [Input](#input).
`--answer` for a run whose last task did not complete
with the status `waiting` prints `workflows: run <run-id> does not wait for an answer` and `usage: workflows resume
<run-id> [--answer <text>] [--background] [--json]`, and exits 2. See [Input](#input).

A run saved by another version of workflows cannot resume. Resume prints `workflows: run <run-id> was saved by an
earlier version of <workflow> and cannot resume`, or `a later version`, and exits 4, as for a run that is gone.
`<workflow>` is the `name` of its saved input as this version reads it, or `?`. `list` and `show` show these runs as
`earlier-version` or `later-version`, also when their task ended, and read only their task record (see [List](#list)).
The host still starts with such a run in its
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
2 s stops the run: the run's task ends as `aborted`, and the command prints `aborted <title>; continue with: workflows
resume <run-id>` and exits 130. A second Ctrl+C that comes before the command waits for it, such as one right after
the first, stops the run in the same way. A second Ctrl+C while the command follows no run, and a third, exit at once.
A Ctrl+C before the run starts, such as while the command clones the repository, starts no run: the command removes
the run directory, prints `workflows: interrupted before the run started` and exits 130.

When the host closes the connection after it replied to the stop of a second Ctrl+C, it has saved the stop, so the
command prints the `aborted` line, or `{"runId","state":"aborted"}` with `--json`, and exits 130. Otherwise, when the
host stops while the command follows the run, the run stays pending: the command prints `the host stopped;
the run continues when it starts again: workflows resume <run-id>`, leaves the steps as they are and exits 1. The next
host continues the run when it starts, and `resume` starts it.

```sh
workflows stop <run-id>
```

`workflows stop` stops a run that runs, from any directory: it aborts the run's task with its child runs, sessions and
Git steps, prints `aborted <title>; continue with: workflows resume <run-id>` and exits 0. The text follows the state
that the abort gave. It does so also when the host
closes the connection after it replied to the abort, which it saved then. When no host runs, `stop`
starts the run's host, and the host resumes the run before the abort reaches it: a `sh` or `ok` command that a host
stop cut runs again from its start, and an ask that was in progress continues its turn, until the abort stops them. With `--json`, it prints `{ "runId",
"state": "aborted" }`. A run whose last task has ended prints `workflows: run <run-id> is not running` and exits 1.
`stop` also stops a pending run of another version of workflows, which no host can run: its task ends as `orphaned`,
and the command prints `orphaned <workflow>, which an earlier version saved; it cannot resume` (or `a later version`),
or with `--json` `{ "runId", "state": "orphaned", "error" }`. When a host of that other version runs and ends the task
as `aborted`, the command prints `aborted <workflow>, which an earlier version saved` (or `a later version`), with no
`continue with` line, as `resume` refuses that run. A task of this version that the abort ends as `orphaned` prints
`orphaned <title>; it cannot resume`. A command that follows a run that `stop` stops prints the
`aborted` line and exits 130. An aborted run resumes in a new task.

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
saved with `workflows: run <run-id> was saved by an earlier version of <workflow> and cannot be waited for`, and exits
4: no wait can ever follow that run.

Ctrl+C detaches `wait` at once: it prints the `detached` line, or the `detached` JSON line, and exits 130. The run goes
on in the host. A second Ctrl+C exits and never stops the run. Bad usage prints `usage: workflows wait <run-id>
[--json]` and exits 2.

## hc and herdr-app

`workflows` binds no key and opens no hc terminal. It gives the facts and one picker, and harness opens the agent. A
key or a shell composes the commands, such as one that picks a run, then one of its agents, and opens the agent in a
new herdr-app pane to the right:

```sh
c=$(workflows show --pick) && harness attach --conversation "$c" --side
```

`attach --side` opens Pi in a herdr-app pane when `HC_TERMINAL_ID` is set: see [Attach](#attach).

## JSON output

```sh
workflows ship --json plan.md
workflows resume <run-id> --json
workflows wait <run-id> --json
```

Every form of start, resume and wait accepts `--json`, at any position before `--`. After `run <run-id>`, stdout gets one
line of JSON in place of the report lines, for every outcome. Its `state` is the state of the run, the one word that
`list` and `show` give, and only a run that is `done` or `waiting` has a `result`:

- `{ "runId", "state": "done", "result": { "status"?, "code", "score"? }, "value", "report" }`: the run has a result.
  `result.status` is the `status` of the script's result, when it has one, `result.code` the exit code of the
  command, from `meta.exit`, and `result.score` the `score` of the script's result, when it has one: the score of the
  last judge of a ship, a campaign or a judge run. `value` is the whole result of the script, for example
  `{"status":"shipped","rounds":1,"head":"1a2b3c4",...}` for ship; the [Ship](#ship) section lists its fields. The
  value of each workflow of the package has `change: { repository, branch }` as [Branch name](#branch-name) gives
  it.
  `report` is the list of report lines that the command prints without `--json`, such as
  `["shipped Fix the README typo in 1 rounds, judge 1.00, 1a2b3c4", "branch fix/readme-typo"]`.
- `{ "runId", "state": "waiting", "question", "result": { "status"?, "code", "score"? }, "value", "report" }`: the run waits for
  an answer. `question` is the question of its open `input` call, the value is
  `{"status":"waiting","question":"<question>","report":["<question>"]}`, and the exit code is 3.
- `{ "runId", "state": "failed" | "orphaned", "error" }`: the task ended without a result. `error` is the error
  message, or the reason of the orphaned task.
- `{ "runId", "state": "aborted" }`: a second Ctrl+C or `workflows stop` aborted the run.
- `{ "runId", "state": "running", "follow": "started", "workflow", "repository", "posts" }`: with `--background`, the
  host has the run's task, and the command does not follow it. `workflow` is the name of the run's workflow, and
  `repository` the repository of its worktree, else its directory. `posts` is `true` when the end of the task posts
  its outcome to the conversation of the command (the task has `notify`, and its driver is the driver of the
  command), else `false`. The `workflow` tool of the
  host and the `workflow` tool of Pi give it as a result that is not an error.
- `{ "runId", "state": "running", "follow": "detached" }`: Ctrl+C detached the command, and the run goes on in the host.
- `{ "runId", "state": "running", "follow": "host-stopped" }`: the host stopped while the command followed the run,
  which stays pending.

`OUTCOME` in `src/tool.ts` is the schema of this line, and each of its objects has only these fields. The JSON line
replaces the `failed`, `orphaned`, `continue with`, `detached`, `aborted` and `host stopped` lines on stderr, so each
stderr line is a `{"progress":[...]}` line of the run, see [Progress](#progress), or a warning. The exit codes do not
change. An error before the run exists, such as bad usage, prints no `run <run-id>` line and no JSON line. A command
that loses its wait for the run, with an error that is not a closed host, does not say how the run ended: it prints
no outcome line, prints `workflows: <error>` and exits 1, and the run goes on in the host.

## List

```sh
workflows list
workflows list --json
```

`workflows list` prints one line for each run of the harness project of the current directory, newest run ID first:
`<run-id> <workflow> <state> <title>`. Runs of other projects are not listed. `<workflow>` is the script name. Child
runs are not listed: they are tasks of their caller. The title is the last `title(text)` of the run, such as the subject of the intent of
`thermoloop`, else the subject of the first `text` argument, such as the work item for ship and the goal for campaign, or
else the script name. `<state>` is the state of the run, which `runStatus` in `src/run/past.ts` alone computes, with
its result when it has one: `done, result <status> exit <code>`, such as `done, result shipped exit 0` or
`done, result blocked exit 1`, or `done, exit 0` when the result has no `status`. A run that waits for an answer to
`input()` is `waiting`, with its result `result waiting exit 3`. A run whose task has not ended is `running`, also when it waits for its host
to start. A run whose task ended without a result is `aborted` (a second Ctrl+C or `workflows stop` aborted it), `failed` (also a task that pi-durable faulted) or `orphaned`, with no result. A run that
another version of workflows saved is `earlier-version` or `later-version`, also when its task ended: it cannot resume.
For such a run, the command reads only its task record and reads its input only with the input schema of this version:
its workflow is the `name` of its saved input, or `?`, its title is its workflow, and it has no `result`, `question`,
`branch`, `serves` or `item`, no `repository` and no steps. With `--json`, the command prints one JSON array of
`{ "runId", "workflow", "title", "state", "result"?, "question"?, "branch"?, "startedAt"?, "serves"?, "item"?,
"swept"?, "repository", "steps" }`, with the schema `LISTED` of `src/cli/commands/list.ts`. The fields before `repository`
are the run fields, `RUN_FIELDS` of `src/records/run.ts`, which `show --json` and `show --agents --json` give too. `result` is
`{ "status"?, "code", "score"? }` as in [JSON output](#json-output), for a run that is `done` or `waiting`. `question` is the question of a run that is `waiting`. `branch` is
the `change.branch` of the value of the result, the branch that the change is on, else the branch of the run's worktree;
`runBranch` of `src/run/result.ts` gives it, also for the catch-up. A run without a worktree and without a `change` in
its result has none. `startedAt` is the time when the first task of the run started, as an ISO string. `serves` is
what the run serves (see [Serves](#serves)). `item` is the absolute path of the `.md` file that the positional text
argument of the run named, as the run saved it (see [Saved inputs and resume](#saved-inputs-and-resume)); a run
started with inline text or stdin has none. `swept` is the word in the `swept` file of the run directory, `landed` or
`dropped`, which `sweep --yes` wrote when it removed the branch of the run and its worktree (see [Sweep](#sweep)). A run that no
sweep removed has no `swept`.
`repository` is the path of the Git repository of the run's worktree, as the run saved it, and it is `null` for a run
without a worktree.
`steps` has the step lines of the run, the same lines as the `steps` of `show <run-id> --json`: a step that still runs
when the run ended gets the mark of its end.
Only the runs that have a run directory with a `project` file are listed. The command writes that file before it
prepares the run, so a run directory of the project whose run has no task is listed as `<run-id> - unstarted -`, and
with `--json` as `{ "runId", "state": "unstarted", "repository": null }`, with no other field: its run is about to
start, or its command stopped before the host created the task. `LISTED` is the union of these two strict shapes,
`ROW` of `src/cli/saved.ts` for a run with a task and the shape of an unstarted run. `list` takes no argument.

`list` reads the project store file read-only and does not start the host, so no run continues. It takes no lock that
the host waits for, and runs no checkpoint of the file. A store whose schema pi-durable must update first cannot open
read-only: `list`, `show` and `save` then fail with `<store> needs a schema update that only its harness host makes:
start the host once, such as with harness --project <project> host, and run the command again`.

## Sweep

```sh
workflows sweep [<branch>|<run-id>...] [--yes] [--install-hook] [--json]
```

`workflows sweep` prints one line `<run-id> landed <branch> <worktree>` for each run of the harness project of the
current directory, newest run ID first, whose worktree is on a merged branch. With `--json`, it prints one JSON array
of `{ "runId", "swept", "branch", "worktree" }`, with the schema `SWEPT_RUNS` of `src/cli/commands/sweep.ts`. `swept`
is the word that `--yes` writes for the run: `landed` for a merged branch, `dropped` for a branch that is not merged.
Without `--yes`, each line and each entry shows the word that `--yes` would write. A run is a candidate only when it
has a run directory with a `project` file, its last task has ended, a task of this version or of an earlier version
saved it, its saved input has a worktree, the worktree exists, and the worktree is on a branch. For a run of an earlier
version, `sweep` reads only the `worktree` of its saved input. A run of a later version, a run without a worktree, a
run that has not ended, a detached worktree, and a worktree that is not a Git worktree of its own are never swept.
`sweep` reads the project store file read-only, as `list` does, and does not start the host. When the project store
file does not exist, `sweep` prints `workflows: cannot sweep: the project store <store> does not exist, so no run
directory counts as unstarted; remove the run directories that you do not need from <runs directory> by hand`, removes
nothing and exits 1, also without `--yes`. With arguments, `sweep` needs no project store.

For each candidate, `sweep` first runs `git merge-base --is-ancestor refs/heads/<branch> refs/heads/main` in the
worktree, then `git merge-base --is-ancestor refs/heads/<branch> origin/main`. A branch is merged when one of them succeeds: the commit that the
worktree is on is in the local `main` or in `origin/main`, which is also true of a worktree with no commit of its own.
Otherwise, when `git remote get-url origin` succeeds, `sweep` runs
`gh pr list --head <branch> --state merged --json headRefOid` in the worktree, and a branch is merged when one pull
request in the list has the commit that the worktree is on as its head. A repository with no `origin` gets no `gh`
call, and its branch is not merged. A branch name that comes back in a later run, with a merged pull request of an
earlier commit, is not merged. `sweep` runs every `gh` call before it removes anything. A failed `gh` call, a missing
`gh`, or a `gh` output that is not a list, prints `workflows: cannot ask gh whether <branch> is merged, so it counts as
not merged: <error>` on stderr, and the branch is not merged: a run of the project is left out, and a given branch
gets `dropped`.

With `--yes`, `sweep` removes each worktree in order, and prints its line after the removal. It runs
`git worktree remove <worktree>` in the run's repository, without `--force`, and deletes the branch with
`git branch -D <branch>` when the branch still exists. Before it removes anything of a run, `sweep` reads the root
tasks of the run from the store again. When the last task has not ended now, such as a resume that started during a
`gh` call, it prints `workflows: skips <run-id>: its run has a task that has not ended; sweep it after the run ends` on
stderr, removes nothing of the run, leaves it out of stdout and the JSON, and goes on with the next run; the exit code
does not change. Then it writes the marker `runs/<run-id>/sweeping`, a JSON object
`{ "branch", "repository", "path"?, "swept" }`, removes the worktree, removes the branch, writes the word to the file
`runs/<run-id>/swept`, `landed` or `dropped` and a newline, and deletes the marker. An ended run with a marker is a
candidate with the word of its marker, with no other check and no `gh` call, so a `sweep` that stopped after the
worktree removal is finished by the next one. A run with a marker whose last task has not ended is not a candidate,
and each new task of a run deletes its marker before its worktree step. A removal that fails, such as of a worktree
with changes, prints `workflows: cannot sweep <run-id>: <error>` on stderr, leaves the run out of stdout and the JSON,
and goes on with the next run; `sweep` then exits 1. A failed worktree removal deletes the marker and writes no word,
as the worktree can get more work; a failed branch removal keeps the marker. The run directory and the run's records
stay, so `list` and `show` still show the run, and their JSON gives the word as `swept` (see [List](#list)).

`sweep` also prints one line `<run-id> unstarted <run directory>` for each run directory of the project whose run has
no task (the `unstarted` runs of `list`) and whose `project` file is more than 1 hour old, after the merged runs. With
`--json`, each is an object `{ "runId", "directory" }` in the same array. With `--yes`, after every `gh` call, `sweep`
removes these run directories. A run directory with `repository/` or `.worktrees/` is kept when the clone in
`repository/` has a commit that no remote branch reaches: `git rev-list -n 1 --branches <worktree HEADs> --not
--remotes`, with the HEADs from `git worktree list --porcelain`, prints a commit, or a Git call fails. `sweep` then
prints `workflows: keeps <run directory>: it holds a Git clone with commits that are on no remote, or one that Git
cannot read; push them, or remove the directory by hand` on stderr, leaves the directory out of stdout and the JSON, and
the exit code does not change.

With arguments, `sweep` takes only the branches that they give, in the given order and each once, in the main
checkout of the repository of the current directory (the first worktree of `git worktree list`), and leaves the
unstarted run directories. It needs no project store: without one, no run has a branch. An argument is a run ID or a
branch:

- A run ID of the store, root or child, gives the branch of the run: the `change.branch` of its result, else the
  branch of the worktree of its saved input, else the worktree branch of its newest direct child run that has a
  worktree. A direct child run is a run with a task that a task of the run owns. So a `thermoloop` that reviews a
  branch in the worktree of its child run gives that branch. The run must be of this repository: the main checkout of
  the repository that the same source saved is the main checkout of the current directory.
- Any other argument is a branch. It must be a local branch of the repository, or the branch of a run of it.

The runs of a branch are the runs of the store, root and child, whose result `change` or saved worktree is on the
branch in this repository, and, for a run that has neither, the run whose newest direct child run with a worktree is
on the branch. A run whose run directory has a `swept` file and no marker is not a run of the branch: an earlier sweep
removed its branch, so a later branch of that name is not its branch, and its word stays. `sweep` checks every
argument before it removes anything. An argument that it cannot sweep prints one
of these lines, removes nothing and exits 1:

- `workflows: cannot sweep <arg>: no run of this repository and no branch of that name`: a run of another repository
  counts as unknown.
- `workflows: cannot sweep <arg>: an earlier sweep swept its branch <branch>`: the run directory of the run `<arg>`
  has a `swept` file and no marker.
- `workflows: cannot sweep <arg>: the run has no branch`: the run and its direct child runs have no worktree and no
  `change`.
- `workflows: cannot sweep <arg>: the run <run-id> on <branch> has not ended, or a later version saved it`: a run of
  the branch, root or child, has a last task that has not ended or that a later version saved.
- `workflows: cannot sweep <arg>: no worktree and no branch <branch>`: no worktree has the branch, the branch does not
  exist, and no run directory of a run of the branch has a marker on it.

A marker on the branch in the run directory of a run of the branch gives the word and the worktree path, with no merge
test. Otherwise the worktree is the one that `git worktree list` gives with the branch checked out, and `sweep` runs
the merge test on `refs/heads/<branch>`, in that worktree, or in the repository when no worktree has the branch: a
merged branch gets `landed`, and one that is not merged gets `dropped`. It prints one line
`<run-id> <swept> <branch> <worktree>` for each run of the branch with a run directory, in task ID order, so a root
run comes before its child run, with `-` for the worktree when no worktree has the branch. A branch that no run has
prints one line with `-` for the run ID. In the JSON, such an entry has no `runId`, and an entry has no `worktree` when
no worktree has the branch. With `--yes`, `sweep` reads the tasks of the runs of the branch again, as above, writes the
marker, with no `path` when no worktree has the branch, in the run directory of each run of the branch, removes the
worktree, then the branch, then writes the word to the `swept` file of each run and deletes the markers. A failed
worktree removal deletes all the markers. A branch that no run has gets no marker and no `swept` file.

`--install-hook` writes the executable `post-merge` hook of the Git repository of the current directory, with the line
`workflows sweep --yes >/dev/null 2>&1 &`, and prints the hook's path. When `core.hooksPath` is set or a `post-merge`
hook exists, it writes nothing, prints an error with the line to add, and exits 1. `--install-hook` ignores `--yes` and
`--json`.

## Show

```sh
workflows show <run-id>
workflows show <run-id> --agents [--json]
workflows show <run-id> --json
workflows show [<run-id>] --pick
```

`workflows show` prints one run from the store of its project: the line `run <run-id> <workflow> <state> <title>`,
with the fields of `workflows list`, then the steps of [Progress](#progress) from the first line of the run, then the
report lines, or the `failed` and `continue with` lines. Once the run's task ended, the steps that still ran are `✓`
when it completed, `·` when it was aborted, and `✗` otherwise. The calls of a run are in [Log](#log).

A run without steps prints the tree of its phases and calls in place of the steps:

```text
run <run-id> <workflow> <state> <title>
<phase line>
  ✓ <kind> <label>  <duration>
<report lines, or the failed and continue with lines>
```

- The calls are in the order they started. Each call is under the phase line that was current when it started, and is
  indented by 2. A call before the first `phase` has no phase line above it. The kind is `session`, `ask`, `sh`, `ok`,
  `run`, `input`, `pastRuns`, `todo` or `harness`. An `agent` call is a `session` call and an `ask` call.
- Each call has a state. It is `done` or `failed` once it ended. A call that did not end is `cancelled` when the end of
  its script cancelled it, `waiting` when it is the open `input` call of a waiting run, `running` while the task that
  started it has not ended (it runs now, or the host stopped), and `cut` once that task ended. A call that an earlier
  version saved has no task: it is `running` until the run's task ended, and `cut` after.
- The mark is `◉` for `running`, `✓` for `done`, and `✗` for every other state. A `cancelled`, `cut` or `waiting` call
  shows its state in place of its duration. A session is `◉` while one of its asks is `◉`; once the task ended, it
  keeps its `✓` or `✗`.
- The label is `<role> conversation <id>` for a `session` that opened, with the role name and the conversation ID of
  the session, and the role name only for a `session` that did not open. For `ask`, it is the role name of its session. For
  `sh` and `ok`, it is the command on one line, cut at 80 characters. For `run`, it is the workflow name and the child
  run ID. For `input`, it is the question on one line, cut at 80 characters. For `pastRuns`, it is the workflow, or `any` for `null`. For `todo`, it is `add <text>`,
  `set <id> <state>` or `list`, on one line, cut at 80 characters. For `harness`, it is `tree`, `item read <id>`,
  `item set <id> <state>`, or `item link <from> <kind> <to>` on one line, cut at 80 characters. The phase lines and calls of the child run
  are indented by 2 more under the `run` line.
- The duration is the time of the call, such as `12s`, `3m05s` or `1h02m`. For `◉`, also for a working session, it is
  the time since the call started.
- A finished run ends with its report lines. A failed run ends with `failed <title>: <error>` and `continue with:
  workflows resume <run-id>`, an aborted run with `aborted <title>; continue with: workflows resume <run-id>`, and an
  orphaned run with `orphaned <title>: <reason>` and the `continue with` line. A run that another version saved shows
  only its first line, with its workflow as its title, and the line `version <v> of workflows.run saved this run, and
  this is version <n>: it cannot resume`. Any other run ends after its calls.

When a call runs again after a resume, `show` shows only its latest attempt. With `--json`, the command prints one JSON
object with both trees: `{ <run fields>, "agent"?, "todos", "steps", "stepNames", "calls", "agents" }`, with `report` for a run with a
result or `error` for a failed or orphaned run, never both, with the schema `SHOWN` of `src/cli/commands/show.ts`, a
union of these three strict shapes. The run fields are those of [List](#list). `agent` is
`{ "conversation", "project" }`, what `harness attach` needs to open the agent of the run: the agent that works now,
else the last agent to start, as [Attach](#attach) takes it (`runAgent` of `src/records/tree.ts`), and the project of
the run; a run without an agent has none. `error` is the error of a failed run or the reason of an orphaned run, and
`todos` is the list of todos of the run, as in [Todos](#todos): an array of `{ "id", "text", "state" }` in ID order,
or `[]` when the run has no todo, and
`steps` has the step lines of the text, without the first line and the footer. `stepNames` has one item for each
line of `steps`, in the same order: the name of the step of that line, as `workflows log <run-id> <step>` takes it (see
[Log](#log)), or `null` for a log line. Each call is
`{ "kind", "args", "runId", "label", "phase", "state", "mark", "startedAt", "end"? }`, with
ISO times and the arguments of its kind as in [Saved inputs and resume](#saved-inputs-and-resume), and the fields of
its kind: a `session` call has `conversation`?, the conversation ID of a session that opened, and `model`?, the model
that it used; a `sh` call has `output`?, the exit code and the kept output of a failed call; an `input` call has
`ask`?, the ID of its ask; a `run` call has `child`?. `SHOWN_CALL` of
`src/records/tree.ts` is its schema, a strict union with one member for each kind, so a call has no other field. `end`
is the end of a call that ended, as its record saves it: `{ "kind": "done", "at", "result" }`, `{ "kind": "failed",
"at", "error" }` or `{ "kind": "cancelled", "at" }`. `runId` is the ID of the run that made the call. The JSON `mark`
of a working session is `✓`: only the text shows it as `◉`. `phase` is `null` before the first phase line. The
`result` of a `run` call is `{ "runId", "result" }`, with the result of its child run. A `run` call whose child run
started also has `child`, `{ "todos", "calls" }`: the list of todos of the child run, and the calls of the child run.
`agents` is the array of agents of the run, the same as the `agents` of `show <run-id> --agents --json`.

With `--agents`, `show` prints the agents of the run:

```text
run <run-id> <workflow> <state> <title>
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
  model ID of the session, as its `session` call recorded it; the line has no model when the record has none,
  such as a session that an earlier version opened. The duration runs from its start to now while
  it works, else to the end of its last ask.
- A phase line comes before the first agent or child run under it. Other calls, such as `sh`, are not in the tree. The
  rows of a child run are indented by 4 more under its `run` line.

With `--agents --json`, the command prints one JSON object `{ <run fields>, "agent"?, "ended", "agents" }`, with the
schema `SHOWN_AGENTS` of `src/cli/commands/show.ts`, where the run fields and `agent` are those of `show --json`, and
`ended` is true when the run has ended, also when it waits for an answer, and for a run that another version saved.
`agents` has one object for each line of the tree, in order, with the schema `AGENT_ROW` of `src/records/tree.ts`:
`{ "kind": "phase", "depth", "text" }`, `{ "kind": "run", "depth", "mark", "text" }` with the text `run <workflow>
<child run-id>`, or `{ "kind": "agent", "depth", "mark", "text", "phase", "model"?, "asks", "conversation",
"startedAt", "endedAt"?, "facts" }`, where `phase` is the phase line of the session, or `null` before the first phase
line, `model` is `{ "provider", "model", "thinking"? }`, the model of the session, `endedAt` is absent while
the agent works, and `facts` is the text after the agent text in its line, such as `claude-opus-5-5  1 ask  31s`.
`depth` is the nesting of child runs.

With `--pick` and no run ID, on a terminal, the command first asks `Pick a run:` with the runs that run or wait first,
each as `<mark> <title>  <workflow> <state>`, with `: <status of the run>` of [Progress](#progress) for a running run.
The runs are those of `list` without the unstarted ones. The mark is `◉` running, `?` waiting, `✗` failed or orphaned
(a task that ended without a result, not a result whose `status` is `failed`), else `·`. Typing filters by each word,
in any case; the arrows move, Enter takes the run, and Esc or Ctrl+C exits 130. While the pick waits for a key, the
command reads the runs again 1 s after each read ends and draws the new lines, with the typed filter kept and the cursor
on the same run, else on the first match. A read that fails keeps the lines it has, and a read that finds no run shows
`nothing matches`. A project with no run at the first read prints `workflows: no runs in the project of <cwd>` and
exits 1.

With `--pick`, on a terminal, the command then asks `Pick an agent:` with the lines that `show` prints of the run: the
first line, the steps, or the calls of a run without steps, then the footer. It prints the conversation ID of the agent
of the line that the pick takes, for [`attach --conversation`](#attach) or `harness attach --conversation`, in both
forms. Only a line with an agent can be taken; Enter on another
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
the pick exits 130. `--pick` without a terminal, with `--agents` or `--json`, or with more than one run ID, is bad
usage.

`show` exits 0 for every run it can show. It reads the project store through pi-durable's storage functions, as `list`
does, and does not start the host. It reads the file read-only as `list` does. An unknown run ID, or a run directory
without a `project` file, prints the
`no run` error of `resume`. `show` shows a run that another version saved, ended or not, from its task record only,
as `list` does: with `--json` it has empty `todos`, `steps`, `calls` and `agents`, and no `report` or `error`.
`resume`, `wait` and `save` refuse it. Bad usage, such
as no run ID without `--pick`, prints `usage: workflows show (<run-id> [--agents] [--json] | [<run-id>] --pick)` and
exits 2.

## Log

```sh
workflows log <run-id>
workflows log <run-id> <step>
workflows log <run-id> <call>
workflows log <run-id> --follow
```

`workflows log` prints what a run did from the store of its project: its steps first, then the calls of one step, and
the full output of one call. It reads only the root tasks, the progress and the call records of the run, in one read,
so it also prints the steps, the calls and the end of a run that another version saved, which `show` leaves out. The
end line has the state of the outcome of its task.

The short log is flat, with no indent. Each line is the time, two spaces, the path of its run in brackets, a space,
then what happened:

```text
HH:MM:SS  [ship] start
HH:MM:SS  [ship/rpi] start
HH:MM:SS  [ship/rpi] research  10s  2 calls  2.4 KB  <child run-id>/s1
HH:MM:SS  [ship/rpi] plan  failed  36s  18 calls  6.5 KB  <child run-id>/s2
HH:MM:SS  [ship/rpi] sh <label>  failed  3s  exit 1  120 B  <child run-id>/<call>
HH:MM:SS  [ship/rpi] | <last lines of the error>
HH:MM:SS  [ship/rpi] failed  1m18s
HH:MM:SS  [ship/rpi] | <last lines of the error of its run call>
HH:MM:SS  [ship] failed  1m45s
HH:MM:SS  [ship] | <last lines of the error of the run>
```

- The path is the workflow of the root run, then the workflow of each child run down to the run of the line, joined
  with `/`. The workflow of the root run is the name in the saved input of its task, as `list` gives it, and `?` for a
  run with no task. The workflow of a child run is the `name` of its `run` call.
- Each run has one `start` line, at the start of its first task (a child run at the start of its `run` call), and one
  end line when its last task has ended. A resume does not print a new `start` line. The end line is the status of the
  result of the run (`shipped`, `blocked`, ...), else the state of its last task (`done`, `waiting`, `failed`,
  `aborted` or `orphaned`), then two spaces and the duration of the run: the time from its start to its end, also the
  time between a stop and a resume. Its time is that of the last end event of the run, when its last start or end
  event is an end, else the end time of its task. A run with no start or end time has no duration. Each task of a run,
  a resume too, starts it again, so a run that failed and then ended after a resume has one end line, its last one. A
  child run takes the task of its `run` call. A run that has not ended has no end line. A run whose task has not
  ended and that another version saved has the state of its task after `start`: `start  earlier-version` or `start
  later-version`.
- For each run, its steps are in the order they started. A step is a `phase` line of the run; a `phase` line that
  continues the step of the same text, after a resume, is no new step. A call is in the last step of its run whose
  text is the phase of the call and that started at or before the call, as in `show`. The calls that are in no step,
  such as the calls of a script with no `phase`, are in step `s0`, which has no line in the short log. The time is the
  local time of the line; a line with no time, such as a line that an earlier version saved, has a blank time column,
  and a step with no time comes first. The `log` lines of a script are not in the short log.
- A step line has its text, cut at 80 characters, then `running` for a step that runs, `failed` for a step that
  failed, or `aborted` for a step of an aborted run, then the duration of its step as `show` gives it (the time to the
  next phase line or end of its run, without the time between a stop and the resume that continues the step), the
  count of its own calls (`1 call` or `<n> calls`), the size of their output, and the name of the step. A step that
  has not ended has no duration. The count and the size include the `run` calls of the step and not the calls of its
  child runs, which have their own step lines. Once the run has ended, its steps that still ran take the end mark of
  [Show](#show), and the word of that mark.
- Under each step, in start order, are its calls that did not end done (failed, cut, cancelled, running or waiting).
  A call that ended done has no line: `workflows log <run-id> <step>` gives it. A `run` call whose child run started
  has no line: the lines of its child run are in its place, from its `start` line to its end line. A `run` call whose
  child run did not start is a call as any other.
- A call line has the kind and the label of the call tree of [Show](#show), then its state word (`failed`,
  `running`, `waiting`, `cancelled` or `cut`) when it is not done, then its duration when it ended. A `sh` or `ok` call
  with a result, and a `sh` call whose record keeps its output, has `exit <code>`. The size is the UTF-8 size of its
  output in `B`, `KB` or `MB`: the stdout and the stderr of such a call, else its result (a string as it is, else its
  JSON) or its error. The last field is the name of the call.
- A failed call has the last 5 lines of its error under it, each as `| <line>` after the time of its end and its path,
  cut at 120 characters.
- A root run that ended `failed` or `orphaned` has the last 5 lines of the error of its last task under its end line,
  in the same way. The error is the one that `show` gives. A child run whose `run` call failed has the last 5 lines of
  the error of that call under its end line.

The name of a step is `s<n>`, where `n` counts the steps of the run from 1, for a step of the root run, and
`<child run-id>/s<n>` for a step of a child run. `workflows log <run-id> <step>` prints the line of the step, then the
line of each of its own calls in start order, done calls too and `run` calls, with the last lines of the error of a
failed call, in the shape of the short log. Step `s0` has no line of its own: it prints only its calls. The calls of its
child runs are not in it: their steps have their own names.

The name of a call is its key in the store: `<hash>.<n>` for a call of the root run, and `<child run-id>/<hash>.<n>` for
a call of a child run. `workflows log <run-id> <call>` prints that call in full: `call <call>`, its kind with its
whole command or its label, `phase <phase>` (`-` before the first phase), `started <ISO time>`, and `ended <ISO time>
<duration>`. A `session` or an `ask` then has `conversation <id>: workflows attach <run-id> --conversation <id>`. A `sh`
or `ok` call with a result then has `exit <code>`, `--- stdout (<size>)` with its whole stdout, and `--- stderr
(<size>)` with its whole stderr. A failed `sh` call whose record keeps its output has the same lines with the kept
output, then `--- error` with its error. Another call has `--- args` with its args as JSON, then `--- result` or `--- error`. A
call that has not ended has `the call still runs; the store gets its output only when it ends` in place of the
`ended` line: the store has no partial output of a call.

With `--follow`, the command prints the short log, then reads the store again every second and prints each line that
it has not printed yet, such as a call that failed or a new step, in log order. A step line prints again when its step
ends, with its duration, count and size. A call line prints again when the state of the call changes and the call still
has a line; a call that ends done does not print again. The `start` line of a run prints once, also after a resume. An
end line prints again when its run ends again in another state or at another time. It exits 0
after a read that finds the run's task not `running`, also when the run has no task. Ctrl+C exits 130.

`log` exits 0 for every run it can read. An unknown run ID prints the `no run` error of `resume`, and a run with no
task, no progress and no call records prints `workflows: run <run-id> has no workflow`; these exit 4. An error of the
read exits 1. Bad usage exits 2 and prints `usage: workflows log <run-id> [<step> | <call>] [--follow]`: no run ID,
more than one step or call, `--follow` with a step or a call, `--json`, an unknown step, which prints `workflows: no
step <step> in run <run-id>`, or an unknown call, which prints `workflows: no call <call> in run <run-id>`.

## Attach

```sh
workflows attach <run-id> [--conversation <id>] [--side]
```

`workflows attach` opens one session of a run in Pi, as `harness attach --conversation <id>` does:

- The sessions are the agents of `show --agents`, the `session` calls of the run and of its child runs that opened a
  conversation, in the order they started. With `--conversation <id>`, only the session of that conversation counts,
  as `show --json` and `show --pick` give it.
- The command opens the session that works now, as `show --agents` marks it `◉`. When no session works, it opens the
  last session that started. `show --json` gives the same session as its `agent`.
- It runs `harness --project <project> attach --conversation <id>`, with `--side` when given, with the harness CLI of
  this install, in this terminal, and exits with its code. A child that a signal ends exits 1. Harness owns the open:
  it starts the host of the run's project when none runs, checks the conversation before Pi starts, and runs Pi in
  this terminal. With `--side` in an hc terminal (`HC_TERMINAL_ID` is set), it opens Pi in a new herdr-app pane to the
  right of this terminal instead, and exits 0. See the harness spec, Open in Pi.

A run with no session prints `workflows: run <run-id> has no session`. A conversation that is not a session of the run prints
`workflows: run <run-id> has no session with conversation <id>`. A run of another version has no session. These exit
1. An unknown run ID prints the `no run` error of `resume`, and exits 4. An
error of harness, such as an unknown conversation or an hc failure, is the stderr of harness, and exits 1. Bad usage,
such as no run ID or a second argument, prints `usage: workflows attach <run-id> [--conversation <id>] [--side]` and
exits 2.

## Save

```sh
workflows save <run-id> <name> [--force]
```

`workflows save` writes the script of a run to `scripts/<name>.js` of the project folder, and prints the absolute
path of the file. The folder is made when it does not exist. Then `workflows <name>` runs the script, so a script that
started from stdin or from a file can run again by name. The file has the full text of the script that the run saved,
with its `export const meta` header. Only the script is saved: no prompts, agents table or scripts of child runs.

- The name is lowercase letters, digits and `-`, and starts with a letter or a digit. Another name, not exactly one
  run ID and one name, or another flag, prints the error, then `usage: workflows save <run-id> <name> [--force]`, and
  exits 2.
- A command name, one of `COMMAND_NAMES` of `src/tool.ts`, prints `workflows: <name> is a command and cannot be a
  workflow name` and exits 1.
- An unknown run ID, or the ID of a child run, prints the `no run` error of `resume`. A run saved by an earlier
  version prints `workflows: run <run-id> was saved by an earlier version of <workflow> and cannot be saved`, and a
  run saved by a later version prints the same with `a later version`. These exit 4. Another error exits 1.
- When a project or package workflow of the name exists, the command prints `workflows: a workflow <name> exists;
  replace it with --force` and exits 1. With `--force`, the file replaces the project script of the name, or adds a
  project script before the package script of the name.

`save` reads the project store as `show` does, and does not start the host. It exits 0 when it wrote the file. `--json`
has no effect.

## Outline

```sh
workflows outline [<workflow>] [--json]
```

`workflows outline` prints the `meta.outline` of one script, or of every script, before a run. It reads the scripts
as a run does: the project folder first, then the package. It starts no run, does not connect to the host, opens no
store and calls no model.

- `<workflow>` selects one script as `check` does: `-` reads the script from stdin and gives the name `stdin`, a word
  that ends in `.js` or contains `/` is a file and gives its name without `.js`, and any other word is a name.
  Without `<workflow>`, the command takes every script, in the order of `workflows` without arguments.
- The text form prints one line for each script: its name, padded to the longest name that the command prints, two
  spaces, then the labels of the top-level steps joined with ` ─ `. A script without an outline prints its name
  alone. `workflows outline judge` prints `judge  judge`, and `workflows outline` prints for the package scripts:

  ```text
  campaign    split ─ each item: ship ─ judge
  fix         fix ─ judge
  implement   implement
  judge       judge
  optimize    each item: baseline ─ inv ─ dom ─ compose ─ each item: ship ─ select
  rpi         research ─ plan ─ implement
  ship        research ─ plan ─ implement ─ review, in rounds ─ judge
  thermoloop  review ─ fix, in rounds
  ```

- With `--json`, the command prints one line: the catalog entry of `<workflow>`, or the array of the entries of every
  script, with the schema `CATALOG_ENTRY` of `src/cli/commands/outline.ts`. An entry is
  `{ "workflow", "description", "args", "placement", "exit", "outline", "usage" }`, the checked `meta` of the script:
  `description` is `""` for a script without one, `args` maps each argument to its spec as `meta.args` gives it,
  `placement` is `here`, `repo` (`repo: true`) or `worktree` (`worktree: true`), `exit` maps each status to its exit
  code, `outline` is the outline as the script declares it, `[]` without one, and `usage` is the usage line of
  `workflows <workflow> --help` without `usage: `. A script whose `meta` is bad gives the entry
  `{ "workflow", "error" }` in its place, where `error` is the message of a run of it, `<name>: <problem>`, such as
  `bad: meta.outline/0/kind must be agent, run or loop`; the other scripts keep their entries.

An unknown name fails as it fails for `check`: `workflows: unknown command <name>`, then the usage lines, and exits 2.
In the text form, a bad `meta` of a script that the command reads prints `workflows: <name>: <problem>` and exits 1;
with `--json`, it gives an error entry and the command exits 0. More than one workflow, or another flag, prints the
error, then `usage: workflows outline [<workflow>] [--json]`, and exits 2. `--background` has no effect. Else the
command exits 0.

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
directory, starts the host when none runs, asks it to start the run's task, and follows the run. `resume`, `wait`,
`stop`, `show` and `save` read the `project` file, so they reach the run's project from any directory.

- The host loads its entries when it starts: the `piDurable` entries of the packages in Pi's settings, and the entries
  of harness's `entries.json`. Each command that can start a host sets the entry `workflows` there to `dist/entry.js`
  of its install, or `src/entry.ts` of a checkout. The Pi extension sets it too when it loads, see [Pi](#pi). A
  host that started with another version of workflows runs that
  version until it restarts. A host that started before the entry was set refuses a start with
  `workflows: Unknown task kind: workflows.run: the harness host started before it had the entry of workflows; stop it
  so it starts again with the entry (the harness host of project <project> has pid <pid>: kill <pid>)`, and no run
  directory stays. When the entry loads, it compares the version of its `@earendil-works/pi-durable` with the version of
  the one that its harness resolves. When they differ, the load fails with `workflows uses
  @earendil-works/pi-durable <version>, but its harness uses <version>; install equal versions of the @earendil-works
  packages for harness and workflows`, and the host does not start: the command says `The harness host exited
  with code 1; see <host.log>`, and the error is in `host.log`. A host of a project inherits the environment of
  the command that starts it, so `sh` and `ok` calls and the sessions' tools see that environment.
- `sh` and `ok` run in the host's process. A host that stops, or crashes, stops its runs, and the host continues them
  when it starts again.
- The sessions of a run are children of the run's task in harness's children library, keyed `wf:<run-id>/<call
  key>`. The task of each resume finds the sessions of the earlier tasks of the run. When the run completes, its task
  closes its sessions and their subagents. When it fails or stops, it closes only what is under its sessions, such as
  their subagents, and stops the turns of its sessions, which stay for a resume.
- The run lists its sessions in the session-scoped document `workflows.sessions` of the project store, keyed by the
  root run ID. Each record has `run`, `conversation`, `task` and `label`, the role name that opened the
  session. A record that an earlier version saved can have no `label`. This `label` is not the call label of `show`.
- Each try of a run is a task that harness starts with the key `wf:<run-id>#<n>`, from 1. A new task of a run gets the
  highest `<n>` of the run's keys in harness's document of keys, plus 1. Resume reads these keys in the same read of the
  store as the task that it continues. `stop`, and `resume` of a task that has not ended, reach the task by its own key
  in that document. A task that has no key there, such as one that no `start` created, fails them with
  `workflows: run <run-id> has no harness task key for its task <task-id>`.
- The entry gives the host the catch-up hook `workflows.runs`. Before each input of the project agent, the host calls
  it with what it said the agent saw at the last catch-up, `{ lastTaskId, pending }`: the highest task ID of harness's
  document of keys, and the `workflows.run` tasks that were not terminal. The hook reads each task after `lastTaskId`,
  and each task in `pending`. A task of another kind is skipped, and a task that is not terminal goes in `pending`.
  The lines are `Workflow runs that ended:`, then one line for each run that ended,
  `- <run-id> (<workflow>): <state>`, with `; subject: <subject>`, `; branch: <branch> @ <head>`,
  `; divergence: <divergence>`, `; lessons: <JSON>` and `; sessions: [run <run>: <label> #<conversation>, ...]` when
  they are known, then `Workflow runs that cannot be reported:` and `- task <id>: <reason>` for a task whose input is
  not a workflows run input, and a task in `pending` whose record is gone. A block with no line is left out. The state
  is the state of the run from `runStatus`, with its result as [List](#list) gives it, such as `done, result shipped
  exit 0`, `failed` or `orphaned`. The branch is
  `change.branch` of the result, else the branch of the run's worktree. The sessions come from `workflows.sessions` of the root run; a
  session without a label shows its lineage key, and without one only `#<conversation>`. The data of the lines is
  `{ runs, lost? }`, with the schema `CATCH_UP` of `src/run/catchup.ts`: `runs` has `{ task, runId, workflow, state,
  result?, subject?, branch?, head?, divergence?, lessons?, sessions }` for each run, where `result` is
  `{ status?, code }` for a run that is `done` or `waiting` and whose saved input has the fields of a title, with `{ run, conversation, key?, label? }` for each session, and `lost` has
  `{ task, reason }`. The first time, and with a `seen` that is not valid, the hook only records the runs, with no
  line. When a read fails, the hook fails: the host warns `catch-up: workflows.runs: <message>`, keeps the last `seen`,
  and the next catch-up reads the same runs again.

### The `workflow` tool of the host

The entry also gives the conversations of the host the `workflow` tool: the project agent, its subagents, and the
subagents of sessions. The sessions of a run do not get it. `src/tool.ts` defines it once for the host and for Pi: its
description, its parameters, its output schema, the command arguments of a call, how the command runs and how its
stderr lines become progress updates and steps, and the text and the outcome of a result. The description tells the model to start or resume a run only when the user asks for that run in his
message, and that a contract or a goal file is not a go; the skill gives the same rule. The host tool has no prompt
guidelines. It takes the parameters of [The `workflow` tool](#the-workflow-tool) of
Pi, and runs the `workflows` command of the same install as a child process with the Node of the host, in the
`cwd` of the call, else the directory of the conversation, with `--json`. `args.agents` reaches the command as `--agents=<text>`, so a bad part is the
error result of the command's usage error, before a run exists. It sets `HARNESS_PROJECT` to the project of the host and
`PI_SESSION_ID` to the conversation ID.

- When the command prints `run <run-id>`, the running output of the call gets `run <run-id>: if this call stops, the
  run is detached and goes on in the harness host; follow it with resume: "<run-id>"`. Each stderr line appends a line to the running output, the last progress line or the line itself,
  and sets the `details` of the call to `{ steps }`, the progress lines of the command then any other stderr line.
  The result keeps the last `details`. The host follows the rule of Pi for progress lines: a progress line is a JSON
  object with a `progress` array, whatever the order of its keys, and the host keeps only the last 100 stderr lines
  that are not progress lines, for the steps and for the error text of a failed command, which has no progress line.
- The result text of a run that is `done` is its summary, then the `report` lines. A report line longer than 4000 bytes
  in UTF-8 is cut at a character to 3997 bytes, then `…`, so it is at most 4000 bytes; the structured output, `--json`
  and the saved result keep the whole line. The summary is
  `run <run-id> <state>: <value>`, with the state and the result as [List](#list) gives them, such as
  `run <run-id> done, result shipped exit 0: {...}`, and the JSON of the value of the result. When the value is an
  object, the summary leaves out its top-level `memory` and `report` keys, so the report lines are not given twice;
  nested keys and the structured output stay whole. A run that waits for an
  answer has only the summary, `run <run-id> waits for an answer: <question>; answer it with resume: "<run-id>" and answer: "<your answer>"`, and is not an error. Only the result of an open `input` call, `{ "status": "waiting", "question", "report" }`, gives this text. A run that is `done` is not an
  error either, whatever its exit code. A failed, orphaned, aborted, detached or host-stopped run is an error result
  with its summary, such as `run <run-id> failed: <error>; continue it with resume: "<run-id>"`, `run <run-id>
  orphaned: <reason>` or `run <run-id> aborted; continue it with resume: "<run-id>"`, and keeps the structured output,
  the outcome of [Wait](#wait), with the whole value and error.
- A summary is at most 2000 bytes in UTF-8, with its prefix and its suffix, and the summary of a waiting run at most
  16000 bytes. A longer summary is three lines: its first line, cut to 500 bytes at a character, then the cut line, then the longest end of the text that fits, from a line
  start when that end has one, else from a character. The cut line of a run that is `done` is `[… <n> bytes cut; the
  command workflows wait <run-id> --json prints the whole result]`. The cut line of a waiting run is `[… <n> bytes cut;
  the command workflows wait <run-id> --json prints the whole question, and workflows log <run-id> <call> prints the
  whole output of a call]`. The cut line of a failed or orphaned run is `[… <n> bytes cut; the command workflows log
  <run-id> shows the run and its calls, and workflows log <run-id> <call> prints the whole output of a call]`. `<n>` is the count of bytes between the two parts. `<run-id>` is the run of the outcome, also
  when the error comes from a child run, whose calls `log` shows under the root. A JSON on one line is cut the same
  way. Every caller text comes from the summary: the result text of the tool, the posted text of a background run,
  and in Pi the tool text, the background message and the drawn outcome line.
- `background: true`, with `name`, `script` or `resume`, adds `--background` to the command. With `save`, it is an
  error and no command starts. The result is the outcome with `follow: "started"`, which is not an error. With
  `posts: true`, its text is `run <run-id> started in the background; its result comes as a message in this
  conversation when it ends; follow it with resume: "<run-id>", or stop it with the command workflows stop
  <run-id>`. With `posts: false`, its text is `run <run-id> started in the background; no message in this
  conversation gives its result; follow it with resume: "<run-id>", or stop it with the command workflows stop
  <run-id>`.
- A task whose input has `notify` and `driver` (it saves `notify` only with a driver) posts its outcome to the conversation `driver` in the commit that ends its task,
  after it ends its sessions. An end commit that fails posts nothing, so the post is always the outcome that the task
  ends with. The post is a follow-up input of the entry kind `workflows.result`, with the
  data `{ runId, state }` and the text of the tool result for that outcome, which the same builder as the command
  makes from the end of the task: `done` with the report lines (with the limits on the summary and the report lines above), `waiting` with
  the question and how to answer it, `failed` with the error, or `aborted`. Its request ID is `workflows.result:<run-id>/<task-id>`, so each later task of the run posts again. A child run never has `notify`. Nothing is posted
  when the task has no driver, such as a task that a terminal or Pi started, or when the host stops: the task
  stays pending and posts when it ends after the restart. A failed post goes to the host's report and does not
  change the outcome of the run. A `background` resume of a task that has not ended changes nothing: the task
  posts to its own driver, only when it has `notify`, and the outcome of the resume has `posts: true` only when that
  driver is the conversation of the resume.
- Esc in a conversation aborts the call: the command gets SIGINT, detaches, and the run goes on in the host. The
  result is an error that keeps the running output, so it names the run, says that it is detached, and says to follow
  it with `resume`. A call
  that a host restart interrupts does not run again; its error result also keeps the running output.
- The command saves the conversation as the `driver` of the task, and each child run, also a new task of a child
  run, gets the driver of its caller's current task. When the driver is the project agent or a conversation of the
  children library, the new sessions of the task are children of that conversation: under the project agent at depth
  1, under a subagent at depth 2. Else, such as for a task with no driver, they are in the tree
  `workflows:<root-run-id>`. A session of a run under a subagent is in the subagent's
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
The publish job first refuses a `@vzlentin/harness` dependency that is not a registry range, such as a Git pin.

`pi.extensions` names `./index.ts` and the extension of pi-agents at both places where npm can put it,
`../pi-agents/index.ts` and `./node_modules/@vzlentin/pi-agents/index.ts`. Pi skips the one that does not exist, and
loads a file with the same real path once, also when Pi's settings list pi-agents too.

`pi.skills` names `./skills`, which holds the skill `workflows` (`skills/workflows/SKILL.md`), and the skills of
pi-agents at the same two places, `../pi-agents/skills` and `./node_modules/@vzlentin/pi-agents/skills`. Pi reads only
the resource types that a manifest names, and it loads pi-agents through the path of its extension, so the skills of
pi-agents need these paths too. Pi skips the one that does not exist, and loads a skill file with the same real path
once. The skill tells the model how to start and follow the runs of ship, campaign, rpi, thermoloop and judge with the
`workflow` tool, and to start or resume a run only when the user asks for one in his message; a contract or a goal file
is not a go. `/skill:workflows <workflow> <input>` asks for a run: the first word is the workflow, and the rest is its
input.

When Pi loads the extension, it resolves `@vzlentin/workflows/package.json` from its own folder, and:

1. It puts the `.bin` folder of the `node_modules` folder that holds `@vzlentin/workflows` last on the `PATH` of Pi's
   process, so Pi's tools find `workflows` and `harness`. It goes last because the folder also holds the commands of
   other dependencies, such as an older `pi`. It removes the folder first, so each load leaves it on `PATH` once.
2. It loads `dist/tool.js` of that package, the definition of the `workflow` tool in `src/tool.ts`, with the names of
   the tool and of the entry.
3. It sets the entry `workflows` in harness's `entries.json` to `dist/entry.js` of that package, with the harness that
   the package imports, so a host that the tool starts loads the entry of the same install. Then it registers the tool
   with the module of step 2.
4. It loads `inHerdr` of `@vzlentin/harness/herdr`, with the harness that the package imports, for the `/workflows`
   command. Another copy of harness in the install, such as an older one of pi-agents, may check another variable.

When `@vzlentin/workflows` does not resolve, the load fails and Pi reports the error. In a checkout, `pi/` resolves the
checkout through the link `pi/node_modules/@vzlentin/workflows`, see the README.

The extension runs each workflow as a child process of the `workflows` command of its dependency
(`<package>/dist/cli.js`), with the Node that runs Pi, in the `cwd` of the call, else the directory of the session, always with `--json`. With `background`, the call returns at once, and the extension posts the outcome of the run to the
session as a message, see [Background runs in Pi](#background-runs-in-pi). So a run that starts in Pi is a normal run of the project of that directory, and `workflows resume`
follows or continues it from a terminal.

### The `workflow` tool

The tool takes one of `name`, `script`, `resume` or `save`, plus `args` with `name` or `script`:

- `name` runs `workflows <name> --<key>=<value>... --json`, with each arg as a flag: a string as it is, `true` as a
  bare `--<key>`, no flag for `false`, and any other value as its JSON text. For example
  `{ name: "ship", args: { item: "Fix the README typo", rounds: 2 } }` runs
  `workflows ship --item=Fix the README typo --rounds=2 --json`. An arg that the script's `meta` does not declare is
  bad usage, so no run starts.
  `{ name: "optimize", args: { workflow: "ship", items: "items/" } }` runs
  `workflows optimize --workflow=ship --items=items/ --json`. A command name, one of `COMMAND_NAMES`, is the error
  `<name> is a command, not a workflow`, and a name that starts with `-` is the error `<name> is not a workflow name`.
  No command starts in either case.
- `script` runs `workflows - --<key>=<value>... --json` with the script on stdin, and each arg as a flag as for `name`.
- `resume` runs `workflows resume <run-id>`. `answer`, with `resume` only, adds `--answer=<text>` and answers the
  ask of a waiting run (see [Input](#input)). With `name`, `script` or `save`, it is the error `answer works only with resume`, and no
  command starts. `answer` works with `background`.
- `save: { runId, name, force? }` runs `workflows save <run-id> <name>`, with `--force` when `force` is true. See
  [Save](#save).
- `serves`, optional with `name` and `script`, names what the run builds: an item ID or a parley slug adds
  `--serves=<value>` before `--json` (see [Serves](#serves)). Without it, the run serves nothing and its JSON has no
  `serves`. With `resume` or `save`, it is the error `serves works only with name or script`, and no command starts.
- `background: true`, with `name`, `script` or `resume`, adds `--background` before `--json`. With `save`, it is the
  error `background works only with name, script or resume`, and no command starts.
- `cwd`, with `name` or `script`, is the absolute path of the directory where the command starts, in place of the
  directory of the conversation. The project scripts, the `.workflows` configuration and the default repository of the
  run come from it. The harness project of the host tool stays the project of the host; the extension of Pi sets no
  `HARNESS_PROJECT`, so its run is a run of the project of `cwd`. The commands that follow a run, `resume` and the
  `wait` of a background run in Pi, run in the directory of the conversation, and find the run by its ID through the
  `project` file of its run directory, as from any directory. With `resume` or `save`, it is
  the error `cwd works only with name or script`. A relative path is the error `cwd must be an absolute path: <cwd>`,
  and a path that is not a directory is the error `cwd is not a directory: <cwd>`. In each case, no command starts.

The tool adds two guidelines to the system prompt. The first tells the model to read `workflows/script.d.ts` of the
package before it writes a `script`, by the absolute path that the tool module computes from its own location. The
second says that `background: true` is for long runs, whose result comes later as a message, and that `resume` follows
the run. The guidelines are at most 1,000 characters. A test checks that `script.d.ts` declares every global and lib
helper that a script gets, apart from the `__` internals, the names that only the lib uses, and the globals of a bare
pi-codemode sandbox: the JavaScript built-ins and the sandbox's own `store`, `load`, `tools`, `ALL_TOOLS`, `text`,
`image` and `exit`.

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
does not make the steps itself. A run that is `done` or `waiting` ends with its `report` lines,
such as `shipped Fix the README typo in 2 rounds, judge 1.00, 4dfb5c8` and `branch fix/readme-typo`. A failed, orphaned, aborted or detached run ends with
the error or the state, and the run ID to resume. The steps are in the `details` of each update and of the result, so the list draws the
same after a reload. The model gets the result text of the host tool: the summary, then the `report` lines of a
run that is `done`, with the limits on the summary and the report lines of
[The `workflow` tool of the host](#the-workflow-tool-of-the-host).

The tool declares an `outputSchema`, `OUTCOME`, the union of the outcomes of [Wait](#wait). Its `structuredContent`
is that outcome:

- `state` `done`: the run has a result, `result` is `{ status?, code }`, `value` is the whole result of the script,
  such as a `blocked` ship result, and `report` is its report lines.
- `state` `waiting`: `value` is `{"status":"waiting","question":"<question>",...}`, and the text is
  `run <run-id> waits for an answer: <question>; answer it with resume: "<run-id>" and answer: "<your answer>"`.
- `state` `failed` or `orphaned`: the run ended without a result, and `error` is its error message or reason.
- `state` `aborted`: `workflows stop` or a second Ctrl+C aborted the run.
- `state` `running` with `follow` `started`: a `background` call started the run, or a new task of it, and does not
  follow it. The extension sets `posts` to `true`, because its wait posts the outcome. It is not an error, its text is `run <run-id> started in the background; its result comes as a message
  in this conversation when it ends; follow it with resume: "<run-id>", or stop it with the command workflows stop
  <run-id>`, and it draws `◉ started in the background`.
- `state` `running` with `follow` `detached`: Esc detached the command, and the run goes on in the host.
- `state` `running` with `follow` `host-stopped`: the host stopped while the command followed the run, which
  continues when the host starts again.

These are the fields of the JSON outcome line of the command.

### Background runs in Pi

At the first `run <run-id>` line of a call with `background`, the extension appends the session entry
`workflow-background` with the data `{ runId, cwd, workflow }`, with the directory of the session as `cwd`, also for a
call with `cwd`, and the `name` of the call as `workflow`, which a `script` or a `resume` call does not give. The entry
has no `repository`. The extension then follows the run with `workflows wait <run-id> --json` in `cwd`. So a call that
is cut after its run line, with no outcome, still posts the result of its run. A result with `follow: "started"` fills
the `workflow` and the `repository` of the outcome into the run that the session follows, and the widget shows them; it
appends no entry. A call with `background` whose own outcome has a `state` that is not `running`, such as a
resume of a run that ended, ends the run as a resume without `background` does, so the wait posts nothing. The wait
finds the run by its ID, so it also follows a run of another project. When the wait prints an
outcome whose `state` is not `running`, the extension sends the message `workflow-result`, with the text of a
call without `background` for that outcome (the summary, then the report lines of a run that is `done`, with the limits on
the summary and the report lines of the host tool; for a waiting run,
the question and how to answer it), the `details` `{ steps, outcome }`,
`display: true`, `triggerTurn: true` and `deliverAs: "followUp"`. It then appends the session entry
`workflow-background-end` with the data `{ runId }`. The renderer of `workflow-result` draws the steps and the outcome
as the tool result draws them, or the text of the message when its `details` are not valid.

At each `session_start`, the extension reads all the entries of the session, of every branch, and follows each run
whose last `workflow-background` entry comes after its last `workflow-background-end` entry. One extension instance
has at most one wait for a run, so a second `session_start` or a `background` resume of a followed run starts no
second wait, and that resume appends no entry. `session_shutdown` sends SIGINT to the waits, which detach and post nothing.

When the context of `session_start` has a UI (`hasUI`), the extension sets the widget `workflows` below the editor,
one time at each `session_start`. It sits above the subagents widget of pi-agents, because `pi/package.json` lists
`./index.ts` first. The widget shows a dim `workflows` header line, then the runs that the session follows, in the
order that they started to be followed, one run on each line: `<workflow>: <repository> <id> <step>`, or `<workflow>: <repository> <id> <step> (<error>)`
after a wait that failed, such as

```text
campaign: harness 935f6d89 item 2/3: Add a thanks line › round 1/3: review
ship: workflows e235d11b plan
```

The workflow is the one of the `workflow-background` entry, or `?` for an entry with no `workflow`. The repository is
the last part of the path of its `repository`; an entry with no `repository` shows none. The short ID is
the part of the run ID after its last `-`. The step is the `status` of the last progress line of the wait, see
[Progress](#progress), else its last line, trimmed, with its mark, or `starting` before the first one; another stderr
line does not change it. The widget redraws when a run starts to be followed, at each progress line,
and at the end of each wait. When the session follows no run, the widget draws no line, and takes no space. After
shutdown, the extension asks for no redraw. As `session_start` follows the pending runs again, they show again after a reload.

An outcome whose `state` is `running`, an outcome line that is not valid, no outcome line, or a wait that does not
start posts nothing and appends no end entry. The extension then waits 1 s and runs the wait again, and doubles the time
before each next wait, up to 60 s. The widget shows the last line of the error of that wait as `<error>`, in
parentheses after the step, until a later progress line. `session_shutdown` ends these retries, so the next
`session_start` follows the run again. A wait that exits 4 with no outcome line, for a run that it can never follow (a run that is gone or
that another version saved), posts nothing and appends the end entry with the data `{ runId, reason }`, where `reason`
is the last line of the error text that the tool gives for that output: of the stderr text, or `workflows exited with
<code>` when it is empty, after `run <id>: ` when the wait printed its run line. A crash between the message and the end entry
posts the outcome again at the next `session_start`.

A call without `background` that resumes a run that the session follows gives the outcome in its own result. When that
result has a `state` that is not `running`, the call appends the end entry, the wait posts nothing, and a wait
that waits to run again stops, so the run leaves the widget. Else the wait
posts the outcome that it gets.

A `save` call returns `{ runId, state: "done", result: { code: 0 }, value: { file }, report: [file] }`, with the absolute path of the
file that it wrote. A `save` that fails is a normal tool error with the stderr text.

An outcome whose `state` is not `done` or `waiting`, other than `follow: "started"`, is an error result that keeps `structuredContent`. Thus
`await tools.workflow({ name: "ship", args: { item } })` in a codemode script gets this object. A call that fails
before a run exists, such as an unknown workflow name, is a normal tool error with the stderr text. A call whose
command printed `run <run-id>` and then stopped with no outcome line is a normal tool error `run <run-id>: <stderr
text>`, or `run <run-id>: workflows exited with <code>` with no stderr, so the error keeps the run ID to resume. A call with
`background` follows its run from that run line, so the session gets the result of the run also after this error.

### The `/workflows` command

`/workflows` composes [`workflows list`](#list), [`workflows show`](#show) and [`workflows attach`](#attach). It runs
`workflows list --json` in Pi's working directory, and lists the runs in that order, one line each:
`<run-id>  <workflow>  <state>  <title>`, with the state and the result as `workflows list` gives them, under the
title `Show workflow run`. With no run, it notifies
`No workflow runs in this project`. When the list fails, it notifies its stderr as an error.

For the chosen run, it reads [`workflows show <run-id> --agents --json`](#show) once. When the `show` fails, it
notifies its stderr as an error, such as `workflows: no run <run-id>`, or `workflows show exited with <code>` with no
stderr. When its stdout is not the expected JSON, it notifies the error `workflows show did not print the expected
JSON`. When the run has no agent, only phase lines and child runs, it notifies `Run <run-id> has no agent`.

Else, it lists the agents of the run and of its child runs in the order of the JSON, one line each, under the title
`Open an agent`:

```text
<indent><mark> <agent text>  <model>
```

The indent is two spaces for each depth of child runs. `<model>` is the model ID of the agent, and an agent with no
model has no `  <model>`. When the line of an
agent is the same as the line of an agent above it, it ends with `  #<conversation>`, so each line is distinct.

Escape on either list ends the command. A chosen agent runs `workflows attach <run-id> --conversation <id> --side`
when Pi runs in an hc terminal, as `inHerdr` of the harness of the workflows package tells from `HC_TERMINAL_ID`, which
opens the agent in a herdr-app pane to the right. Outside an hc terminal, `--side` would run Pi in place, under Pi, so
the command notifies `Run in another terminal: workflows attach <run-id> --conversation <id>` instead. When the
attach fails, it notifies the error `<stderr>. Run in another terminal: workflows attach <run-id> --conversation <id>`.

## Run directory

Runs live in `$XDG_STATE_HOME/workflows/runs/<run-id>`, by default `~/.local/state/workflows/runs/<run-id>`:

- `project`: the name of the harness project whose store holds the run: its saved inputs, calls, sessions and progress
- `swept`: `landed` or `dropped`, after `sweep --yes` removed the branch of the run and its worktree (see
  [Sweep](#sweep)); a child run directory gets it too when its run has the branch
- `sweeping`: the marker of a removal of `sweep --yes` that has not finished

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
- `item-<n>/item.patch`: the whole change of a failed item
- `memory/`: the OptMem store of the run memory of every item

An `rpi`, `thermoloop` or `implement` run without a caller has `memory/`, the OptMem store of its run memory. A
`thermoloop` run without the `patches` of a caller writes `round-<n>.patch` and `round-<n>-fix.patch` into its own run
directory.

An optimize run has:

- `baseline/<path>` and `best/<path>`: the baseline texts of the edited paths and the promoted texts
- `notes.txt`: the note lines of the `compose` turn
- `overlay.diff`: the item lines, the reason lines, the edit lines and the diff
- `memory/`: the OptMem store of the run memory, with one row for each item

A child run that `run()` starts is a run directory of its own, next to the caller's, without a `project` file: it is a
task of the caller's run. A child run without a worktree can have an empty run directory.

## Prompts

`workflows/prompts/` holds the Pi prompt templates `research`, `plan`, `handoff`, `implement`, `review`, `judge` and
`commit`, `split` and `rundown` for `campaign`, `inv`, `dom`, `compose` and `select` for `optimize`, and `harvest`, the
summarizer turn that distils the lessons of the run memory. Edit the wording there. Keep the
frontmatter and the last line `$@`: the run removes them, then adds its inputs as `## <name>` sections.
`workflows/scripts/thermoloop.js` adds the rules of the [review loop](#thermoloop), so a template edit cannot
remove them. `memory(...).session(...).noted` of the [script lib](#the-script-lib) adds the `respond` answer rule
of the handoff and implement turns. In the same way,
`workflows/scripts/campaign.js` adds the `respond` answer rule of `split`. The judge rubric is fixed: its eight
answers, in question order, make the score. `commit`, `compose`, `dom`, `harvest`, `inv`, `judge`, `rundown` and
`select` hold their own `respond` answer rules. A run uses the
templates as they were when it started.

Workflow scripts get every template of `prompts/` as `prompts.<name>`, from the package and the project.

## Source

The engine files in `src/`:

- `cli.ts`: the `workflows` command entry point.
- `cli/main.ts`: the command line: the terminal, the table of commands, usage and `--version`.
- `cli/host.ts`: the connection to the harness host, the task keys, the run directories and the project store file.
- `cli/saved.ts`: the saved runs of the command: their run directory, root tasks and their keys, the status that
  `list` and `show` print, and progress.
- `cli/follow.ts`: how the command follows a run to its outcome, the answer of a waiting run, and the Ctrl+C presses.
- `cli/commands/`: one file for each command: `start.ts`, `resume.ts` (also `wait`), `stop.ts`, `list.ts`, `show.ts`,
  `attach.ts`, `save.ts`, `sweep.ts` and `outline.ts`.
- `command.ts`: the `workflows` command of the package, for the `workflow` tool of the host, which runs it with
  `runCli` of `tool.ts`.
- `cli/commands/log.ts`: `workflows log <run-id>`: the short log of a run, the full output of one call, or the log as
  the run goes on.
- `tool.ts`: the one definition of the `workflow` tool: its description, parameters and output schema, the `workflows`
  command of a call and how it runs, its progress lines and steps, the outcome and text of a result, and the cut rule
  of long texts. The tool of the harness host and the tool of the Pi extension both use it. It imports at runtime only
  `typebox` and Node built-in modules (`node:*`).
- `cli/terminal/pick.ts` and `cli/terminal/keys.ts`: the picker of `show --pick`, and its keys.
- `entry.ts`: the entry that the harness host loads, with the script task and the catch-up hook. It first checks
  that its pi-durable and the pi-durable of its harness have the same version.
- `records/tree.ts`: the call tree of a saved run, its lines and agent rows for `show` and `attach`, and the lines of
  `show` with the agent of each step, for `show --pick`.
- `records/run.ts`: the run fields that `list --json`, `show --json` and `show --agents --json` share, from the root
  tasks of a run.
- `records/steps.ts`: the tree of steps of a run.
- `records/log.ts`: the text of `workflows log`: the flat short log of a run, each line with its time and the path of
  its run, with the start and end of each run, its steps and the calls that did not end done, the calls of one step,
  and the full text of one call.
- `records/store.ts`: the command's read-only reads of the project store: the tasks of the runs, harness's task
  keys, their progress, calls and lists of todos.
- `cli/terminal/redraw.ts`: how the command draws the tree of steps of a run on stderr.
- `launch/input.ts`: the generic entry point `workflows <wf>`: the checked arguments of a run, its run ID, its saved
  input, its driver, the input of a child run, and the input of a new task of a run that ended.
- `launch/args.ts`: the `meta.args` values of the command line, and the texts that they name, and the args of a
  `run()` call, with one check of both against `meta.args`.
- `launch/worktree.ts`: repository selection, the worktree of a run, made by Git, the name of its branch, and the main
  checkout of its repository.
- `run/result.ts`: the title of a run, the status, report lines and exit code of its result, and its branch.
- `workflow/meta.ts`: read and check the `meta` of a workflow script.
- `workflow/find.ts`: find a script, list the scripts, help and usage, usage errors, and the terminal input and output.
- `workflow/bundle.ts`: the bundle of a run (scripts, prompt templates, the merged agents table and the script lib), the
  instructions of a prompt template, and the edits of the bundle for a `run()` call.
- `workflow/roles.ts`: the `agents.json` tables, the `--agents` parser, their merge, and the role of a name.
- `cli/commands/check.ts`: the static analysis of `workflows check`.
- `run/version.ts`: the kind and version of the script task, and the task types that the `run/` files share.
- `run/past.ts`: the saved root runs of the project store, for the `pastRuns` call and `run(name, { from })`, the task
  of a run that the commands go by, the first task of a run, whose list of todos is the list of the run, and
  `runStatus`, the one place that computes the status of a run.
- `run/progress.ts`: the progress events of a run, their document, and the lines that wait for the next call.
- `run/calls.ts`: the workflow script calls and their records in the project store.
- `run/keys.ts`: the one owner of the format of the store keys of the calls, `<run ID>/<call key>`, and of the step
  names, `s<n>` and `<run ID>/s<n>`.
- `run/asks.ts`: the asks of the `input` calls in the store of the host: the asker and the title of an ask, its
  requests, the value of its answer, and the answer of `resume --answer`.
- `run/serves.ts`: the check of what a run serves, an item or a parley, in the store of the host, and the `serves`
  edge from the run to its item.
- `run/sessions.ts`: the sessions on harness's children library, their move to the model of their role before a turn,
  and the end of the sessions of a run.
- `run/child.ts`: the child runs that the `run` calls start.
- `run/sandbox.ts`: the run of a script in the sandbox, with its globals and prompts.
- `run/task.ts`: the task of every script run, its phase, its outcome, and the message of a background run.
- `run/catchup.ts`: the catch-up hook `workflows.runs`, which tells the project agent about the runs that ended.
- `git.ts`: run a process, and Git commands.

The script side in `workflows/`, published as it is:

- `scripts/`: the workflow scripts of the package.
- `lib/`: the helpers that every workflow script gets, in themed files. They run in the sandbox. A function that
  needs only the script calls goes here; one that needs Node or the store, or that every script must have, such as
  the lockdown of `Date` and `Math.random`, stays in `src/`.
- `prompts/` and `agents.json`: the prompt templates and the package agents table.
- `script.d.ts` and `jsconfig.json`: the types of the script globals and the lib, for editors.
