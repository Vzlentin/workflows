# workflows

`workflows` runs durable, resumable coding workflows on [Pi](https://github.com/earendil-works/pi) sessions:

- `workflows ship` ships one work item onto a new Git branch: research, plan, implement, review, judge.
- `workflows campaign` splits a goal into work items and ships them one after another onto one branch.
- `workflows optimize ship` searches for better ship prompts over a set of work items.
- `workflows <script>` runs your own workflow script.

Runs execute in the [harness](https://github.com/Vzlentin/harness) host of the project. A run continues after a
crash or a Ctrl+C, and `workflows resume` follows it again.

## Install

You need Node.js 22.19 or later, Git, and a login for the `anthropic` provider in Pi's agent directory
(`~/.pi/agent`): log in once with `/login` in `pi`, or set `ANTHROPIC_API_KEY`. For GitHub repositories, you also
need an authenticated `gh`.

```sh
npm install -g @vzlentin/workflows
```

This gives you the `workflows` command, and the `workflow` tool in Pi. workflows runs on the global install of
[harness](https://github.com/Vzlentin/harness), so the setup adds `@vzlentin/harness` when it is missing or too old,
with the `harness` command and harness's `subagent` tool in Pi. There is only one copy of harness.

The setup runs after the install with npm 11. npm 12 runs no install script by default, so your first `workflows`
command does the setup. It registers the `pi` folder of each global package in Pi with `pi install <path>`. npm shows
the output of the install only with `--foreground-scripts`, so check the result with `workflows list` and `pi list`.
When you install with `--prefix`, give the same prefix to every `npm` command.

### Update and remove

```sh
npm install -g @vzlentin/workflows@latest                           # update
pi remove "$(realpath "$(npm root -g)")/@vzlentin/workflows/pi"    # remove
npm uninstall -g @vzlentin/workflows
```

npm runs no script when it removes a package, so remove the Pi extension first. Remove harness the same way when you
no longer use it: see its README. After an update, a harness host that runs keeps the old version until it stops. It
stops by itself after 5 minutes with no work.

## Use

```sh
workflows ship plan.md                     # ship the work item in plan.md
workflows ship "Fix the README typo"
workflows campaign goal.md
workflows list                             # the runs of this project
workflows resume <run-id>
workflows wait <run-id>                    # follow a run to its outcome
workflows stop <run-id>
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
source. To release, merge the release PR `release: <version>` that CI keeps open: CI then publishes that version. The Pi extension is in `pi/`, and runs
`dist/cli.js`: to try it from the checkout, run `npm run build`, then `pi install "$PWD/pi"`.

The tests use a fake model provider, a fake `gh`, a fake `workflows` command for the Pi plugin, and temporary Git
repositories. They do not call a real model or open Pi.
