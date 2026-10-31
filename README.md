# workflows

`workflows` runs durable, resumable coding workflows on [Pi](https://github.com/earendil-works/pi) sessions:

- `workflows ship` ships one work item onto a new Git branch: research, plan, implement, review, judge.
- `workflows campaign` splits a goal into work items and ships them one after another onto one branch, then judges
  the whole branch.
- `workflows thermoloop` reviews a change (your current branch, a PR, a ref or a range) and fixes it in rounds;
  `workflows judge` judges it.
- `workflows rpi` researches, plans and implements a work item in one commit, with no review.
- `workflows implement` implements a plan in the current directory and commits it.
- `workflows optimize ship` proposes edits to the ship prompts, profiles, skills and `AGENTS.md` from past ship runs,
  and keeps them when a blind judge prefers the diffs they give.
- `workflows <script>` runs your own workflow script.

Runs execute in the [harness](https://github.com/Vzlentin/harness) host of the project. A run continues after a
crash or a Ctrl+C, and `workflows resume` follows it again.

## Install

You need Node.js 22.19 or later, Git, and a login for the `anthropic` provider in Pi's agent directory
(`~/.pi/agent`): log in once with `/login` in `pi`, or set `ANTHROPIC_API_KEY`. For GitHub repositories, you also
need an authenticated `gh`.

With Pi:

```sh
pi install npm:@vzlentin/pi-workflows
```

This adds the `workflow` tool, the `/workflows` command and the `workflows` skill to Pi. The skill tells the model how
to start and follow the runs of ship, campaign, rpi, thermoloop and judge, and starts a run only when you ask for one;
`/skill:workflows ship "Fix the README typo"` asks for one. Pi installs `@vzlentin/workflows` and
[harness](https://github.com/Vzlentin/harness) with it, in its own npm folder, with harness's `subagent` tool. Pi's
tools find the `workflows` and `harness` commands. There is only one copy of harness.

For the commands in a terminal, add this line to your shell profile. The folder goes last, because it also holds the
commands of other dependencies, such as an older `pi`:

```sh
export PATH="$PATH:$HOME/.pi/agent/npm/node_modules/.bin"
```

Without Pi, install only the command:

```sh
npm install -g @vzlentin/workflows
```

Use one of the two. With both, you get two copies. When their versions differ, a client refuses the host of the other.

### Update and remove

```sh
pi update --extensions
pi remove npm:@vzlentin/pi-workflows
```

Without Pi: `npm install -g @vzlentin/workflows@latest` and `npm uninstall -g @vzlentin/workflows`. After an update, a
harness host that runs keeps the old version until it stops. It stops by itself after 5 minutes with no work.

## Use

```sh
workflows ship plan.md                     # ship the work item in plan.md
workflows ship "Fix the README typo"
workflows campaign goal.md
workflows thermoloop                       # review and fix the current branch against main
workflows thermoloop 74                    # review and fix PR 74 in a worktree of its own
workflows optimize ship --limit 4          # propose and test surface edits from past ship runs
workflows list                             # the runs of this project
workflows resume <run-id>
workflows wait <run-id>                    # follow a run to its outcome
workflows attach <run-id>                  # open its working session in Pi
workflows stop <run-id>
workflows prune --yes                      # remove the worktrees of merged runs
workflows                                  # the workflows that you can run
workflows ship --help
```

A ship run works on the branch `ship/<run-id>` in its own worktree, and renames the branch at the end. It does not push
and does not open a pull request. Its result gives the divergence: one line that tells how the commit differs from the
work item, or `none`. A ship that is not a campaign item, and a campaign, also give `lessons`: up to 3 lessons of its
notes, each also a report line. [docs/spec.md](docs/spec.md) describes all the commands, workflow scripts, runs, and the
`workflow` tool.

Optimize uses past completed ship runs as baselines. An INV turn edits prompts and profiles, a DOM turn edits skills and
`AGENTS.md`. A Compose turn merges the edits into one candidate overlay, with one `kept`, `revised` or `dropped` note
per edit in the report and in `notes.txt`. An invalid candidate does not roll out; the run reports each reason: a skill
without `name` or `description`, a removed skill that `AGENTS.md` names, or an `AGENTS.md` longer than `--always-on-max`
(default: the length of the `AGENTS.md` at the start). A blind judge compares the diffs. The run writes `best/` and
`overlay.diff`, and never changes prompts, skills or `AGENTS.md` on disk. See [docs/spec.md](docs/spec.md#optimize).

## Development

```sh
npm ci
npm run check                              # Biome, oxlint, TypeScript, Vitest
XDG_STATE_HOME=/tmp/wf-dev/state XDG_CONFIG_HOME=/tmp/wf-dev/config node src/cli.ts list
```

`node src/cli.ts` runs the command of this checkout. Give it its own `XDG_STATE_HOME` and `XDG_CONFIG_HOME`, so its
runs, hosts and harness entry do not mix with those of the installed `workflows`. The checkout runs from its TypeScript
source. To release, merge the release PR `release: <version>` that CI keeps open: CI then publishes both packages at that version.

The Pi extension in `pi/` is the package `@vzlentin/pi-workflows`. It runs `dist/cli.js` of its dependency
`@vzlentin/workflows`. To try the checkout's extension in Pi, link the checkout as that dependency, then install `pi/`:

```sh
npm run build
mkdir -p pi/node_modules/@vzlentin && ln -s ../../.. pi/node_modules/@vzlentin/workflows
pi install ./pi
```

Build again after each change in `src/`. The checkout's `pi/` does not bring pi-agents: for the `subagent` tool,
install `pi/` of a harness checkout too, such as `pi install ~/Dev/perso/harness/pi` (see the README of harness).

The tests use a fake model provider, a fake `gh`, a fake `workflows` command for the Pi plugin, and temporary Git
repositories. They do not call a real model or open Pi.
