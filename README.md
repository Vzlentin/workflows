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

This gives you the `workflows` command, and the `workflow` tool in Pi. workflows runs on the global install of
[harness](https://github.com/Vzlentin/harness): the install adds `@vzlentin/harness` when it is missing or too old,
so you also get the `harness` command and harness's `subagent` tool in Pi. There is only one copy of harness.

The install registers the Pi extension of each package with `pi install <path>`, where `<path>` is the `pi` folder of
the global package, and `pi list` shows it. When `pi` is not on your `PATH`, run
`pi install "$(realpath "$(npm root -g)")/@vzlentin/workflows/pi"` later. With `--prefix`, give the same prefix to every
`npm` command. Recent npm versions warn that the install scripts are not in `allow-scripts`; add
`--allow-scripts=@vzlentin/workflows,@vzlentin/harness` to allow them.

### Update and remove

```sh
npm install -g @vzlentin/workflows@latest                           # update
pi remove "$(realpath "$(npm root -g)")/@vzlentin/workflows/pi"    # remove
npm uninstall -g @vzlentin/workflows
```

npm runs no script when it removes a package, so remove the Pi extension first. Remove harness the same way when you
no longer use it: see its README. After an update, a harness host that runs keeps the old version until it stops. It
stops by itself after 5 minutes with no work.

### Move from 0.1.0

0.1.0 had separate Pi packages, and its own copy of harness. Remove the Pi packages, then install again:

```sh
pi remove npm:@vzlentin/pi-workflows npm:@vzlentin/pi-subagent
npm install -g @vzlentin/workflows@latest
```

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
npm run check                              # Biome, oxlint, TypeScript, Vitest
XDG_STATE_HOME=/tmp/wf-dev/state XDG_CONFIG_HOME=/tmp/wf-dev/config node src/cli.ts list
```

`node src/cli.ts` runs the command of this checkout. Give it its own `XDG_STATE_HOME` and `XDG_CONFIG_HOME`, so its
runs, hosts and harness entry do not mix with those of the installed `workflows`. The checkout runs from its TypeScript
source. `npm publish` builds `dist/` first. The Pi extension is in `pi/`, and runs `dist/cli.js`: to try it from the
checkout, run `npm run build`, then `pi install "$PWD/pi"`.

The tests use a fake model provider, a fake `gh`, a fake `workflows` command for the Pi plugin, and temporary Git
repositories. They do not call a real model or open Pi.
