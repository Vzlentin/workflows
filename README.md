# workflows

`workflows` runs durable, resumable coding workflows on [Pi](https://github.com/earendil-works/pi) sessions:

- `workflows ship` ships one work item onto a new Git branch: research, plan, implement, review, judge.
- `workflows campaign` splits a goal into work items and ships them one after another onto one branch, then judges
  the whole branch.
- `workflows thermoloop` reviews the change of your current branch and fixes it in rounds; `workflows judge` judges
  it.
- `workflows rpi` researches, plans and implements a work item in one commit, with no review.
- `workflows implement` implements a plan in the current directory and commits it.
- `workflows optimize ship` searches for better ship prompts over a set of work items.
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

This adds the `workflow` tool and the `/workflows` command to Pi. Pi installs `@vzlentin/workflows` and
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
workflows thermoloop "Fix the README typo" # review and fix the current branch against main
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
and does not open a pull request. [docs/spec.md](docs/spec.md) describes all the commands, workflow scripts, runs, and
the `workflow` tool.

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
