# workflows

`workflows` runs durable, resumable coding workflows on [Pi](https://github.com/earendil-works/pi) sessions:

- `workflows ship` ships one work item onto a new Git branch: plan, implement, review, judge.
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

This gives you the `workflows` command. It includes harness, so you do not have to install harness. Install
`@vzlentin/harness` too if you want the `harness` command.

### Pi

To also get the `workflow` tool in Pi:

```sh
pi install npm:@vzlentin/pi-workflows
```

You can add it now or later.

### Update and remove

```sh
npm update -g @vzlentin/workflows
pi update                                   # when you installed @vzlentin/pi-workflows
npm uninstall -g @vzlentin/workflows
pi remove npm:@vzlentin/pi-workflows
```

After an update, a harness host that runs keeps the old version until it stops. It stops by itself after 5 minutes
with no work.

### Move from the Pi git install

Earlier versions installed with `pi install https://github.com/Vzlentin/workflows` and linked the commands into
`~/.local/bin`. Remove that install and the links first:

```sh
pi remove https://github.com/Vzlentin/workflows
rm ~/.local/bin/workflows ~/.local/bin/harness
```

## Use

```sh
workflows ship plan.md                     # ship the work item in plan.md
workflows ship "Fix the README typo"
workflows campaign goal.md
workflows list                             # the runs of this project
workflows resume <run-id>
workflows stop <run-id>
workflows                                  # the workflows that you can run
workflows ship --help
```

A ship run works on the branch `ship/<run-id>` in its own worktree. It does not push and does not open a pull
request. [docs/spec.md](docs/spec.md) describes all the commands, workflow scripts, runs, and the `workflow` tool.

## Development

```sh
npm ci
npm run check                              # Biome, TypeScript, Vitest
XDG_STATE_HOME=/tmp/wf-dev/state XDG_CONFIG_HOME=/tmp/wf-dev/config node src/cli.ts list
```

`node src/cli.ts` runs the command of this checkout. Give it its own `XDG_STATE_HOME` and `XDG_CONFIG_HOME`, so its
runs, hosts and harness entry do not mix with those of the installed `workflows`. The checkout runs from its TypeScript source. `npm publish` builds
`dist/` first. The Pi plugin is the package in `pi-workflows/`, published from that directory with `npm publish`.

The tests use a fake model provider, a fake `gh`, a fake `workflows` command for the Pi plugin, and temporary Git
repositories. They do not call a real model or open Pi.
