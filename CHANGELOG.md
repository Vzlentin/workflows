# Changelog

## [0.6.0](https://github.com/Vzlentin/workflows/compare/v0.5.1...v0.6.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* `workflows attach <run-id> <step>` is removed. Use `workflows show <run-id> --pick`, then `workflows attach <run-id> --conversation <id>`. In Herdr, `attach` without `--side` opens a tab, not a pane beside HERDR_PANE_ID.
* the positional argument of `workflows thermoloop` and `workflows judge` is the change, not the work item. Give the work item with `--item`.
* a global install no longer runs a setup and no longer installs harness or the Pi packages. Install with `pi install npm:@vzlentin/pi-workflows`, or with `npm install -g @vzlentin/workflows` without Pi.

### Features

* drop the challenge and the evidence rule from the review ([#75](https://github.com/Vzlentin/workflows/issues/75)) ([6663967](https://github.com/Vzlentin/workflows/commit/6663967a80a16a7d1154077df7ff0a4c83ab5488))
* drop the challenge turn from the planner ([#76](https://github.com/Vzlentin/workflows/issues/76)) ([780d073](https://github.com/Vzlentin/workflows/commit/780d0734e6dcc0389801d62d65eec88c41502e43))
* install workflows through Pi, with pi-workflows bringing pi-agents ([#72](https://github.com/Vzlentin/workflows/issues/72)) ([b668552](https://github.com/Vzlentin/workflows/commit/b6685520a869057daadd4a56992e1505ebb052f0))
* pick the agents of a run on its step tree, and open them beside it ([#74](https://github.com/Vzlentin/workflows/issues/74)) ([0cfdce9](https://github.com/Vzlentin/workflows/commit/0cfdce92a509de46d43669ba67e17c8d4741bba9))
* **pi:** ship a workflows skill in pi-workflows ([#79](https://github.com/Vzlentin/workflows/issues/79)) ([c2c52bc](https://github.com/Vzlentin/workflows/commit/c2c52bca721da62473f77e35dd16926a33653eb9))
* refresh the open pickers of show --pick and list --pick while they wait ([#80](https://github.com/Vzlentin/workflows/issues/80)) ([0ccf679](https://github.com/Vzlentin/workflows/commit/0ccf67970c784962ca4d4e11d55af83a6032e871))
* run thermoloop and judge on a branch, PR, ref or range, with the work item optional ([#77](https://github.com/Vzlentin/workflows/issues/77)) ([e0b3973](https://github.com/Vzlentin/workflows/commit/e0b3973df2c17c438534d53d787349a7a87dcba0))

## [0.5.1](https://github.com/Vzlentin/workflows/compare/v0.5.0...v0.5.1) (2026-10-27)


### Bug Fixes

* **pi:** count an install older than the extension as not installed ([#70](https://github.com/Vzlentin/workflows/issues/70)) ([dee6d65](https://github.com/Vzlentin/workflows/commit/dee6d65fe9ead299021f8e7d325baab3127fb2e7))

## [0.5.0](https://github.com/Vzlentin/workflows/compare/v0.4.3...v0.5.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* one script-side root, workflows/ with scripts, lib, prompts and agents ([#64](https://github.com/Vzlentin/workflows/issues/64))

### Features

* keep plain run memory notes when memo of OptMem is missing ([#66](https://github.com/Vzlentin/workflows/issues/66)) ([b647e78](https://github.com/Vzlentin/workflows/commit/b647e7851cfb1db70ba4e66fb1deb1da2e1ff9aa))
* keep the run memory in an OptMem store owned by the outermost run ([#65](https://github.com/Vzlentin/workflows/issues/65)) ([1900cf3](https://github.com/Vzlentin/workflows/commit/1900cf3b3b095b23ea27120147779f279e1f163c))
* put the worktree of a run next to its repository ([#67](https://github.com/Vzlentin/workflows/issues/67)) ([21a50f2](https://github.com/Vzlentin/workflows/commit/21a50f28c95176e2fa0d9c79bd804244d3f43a7c))
* ship as rpi, thermoloop and judge, a shared implement, a campaign judge and run statuses ([#63](https://github.com/Vzlentin/workflows/issues/63)) ([f7cdf0d](https://github.com/Vzlentin/workflows/commit/f7cdf0dece49a7d43f136b2aaade2e8cdbe98c7e))


### Bug Fixes

* **deps:** move to harness 0.5.0 ([#69](https://github.com/Vzlentin/workflows/issues/69)) ([39f0453](https://github.com/Vzlentin/workflows/commit/39f0453fdb75cdbfb35b58352c0b79c4d5395c70))
* hide the experimental SQLite warning of the command ([#61](https://github.com/Vzlentin/workflows/issues/61)) ([4e1f3e2](https://github.com/Vzlentin/workflows/commit/4e1f3e24eca6b58b460e12b0f07390e2df375a72))


### Code Refactoring

* one script-side root, workflows/ with scripts, lib, prompts and agents ([#64](https://github.com/Vzlentin/workflows/issues/64)) ([564421a](https://github.com/Vzlentin/workflows/commit/564421a9f89bf9b525103e3255be2abb5623eadf))

## [0.4.3](https://github.com/Vzlentin/workflows/compare/v0.4.2...v0.4.3) (2026-10-25)


### Bug Fixes

* **deps:** move to pi 1.4.0 and harness 0.4.1 ([#59](https://github.com/Vzlentin/workflows/issues/59)) ([54902b6](https://github.com/Vzlentin/workflows/commit/54902b621e60c7102fef5283edf35309413a7a60))

## [0.4.2](https://github.com/Vzlentin/workflows/compare/v0.4.1...v0.4.2) (2026-10-25)


### Features

* publish the Pi extension as @vzlentin/pi-workflows ([#57](https://github.com/Vzlentin/workflows/issues/57)) ([55ca140](https://github.com/Vzlentin/workflows/commit/55ca1407a470204c927d8bfc9ef03b65c1933ae0))

## [0.4.1](https://github.com/Vzlentin/workflows/compare/v0.4.0...v0.4.1) (2026-10-25)


### Features

* show the agents of a run in /workflows, and attach to the chosen one ([#55](https://github.com/Vzlentin/workflows/issues/55)) ([5d528e7](https://github.com/Vzlentin/workflows/commit/5d528e78dacdcae028ba5c2015f42a6a876f22c5))

## [0.4.0](https://github.com/Vzlentin/workflows/compare/v0.3.4...v0.4.0) (2026-10-25)


### ⚠ BREAKING CHANGES

* name the run branch from the commit subject, and drop the campaign requeue ([#54](https://github.com/Vzlentin/workflows/issues/54))

### Features

* name the run branch from the commit subject, and drop the campaign requeue ([#54](https://github.com/Vzlentin/workflows/issues/54)) ([d5e2512](https://github.com/Vzlentin/workflows/commit/d5e2512453a1cde2e504a087dba6bd96399b3a6c))
* show background runs in Pi, add /workflows, and give a failed campaign item its patch ([#53](https://github.com/Vzlentin/workflows/issues/53)) ([c691e32](https://github.com/Vzlentin/workflows/commit/c691e324222742a385a52a16c98a8885a84aa0e4))
* steps with their time and result in run output and show, list --pick, wait from the first step, and no Herdr workspace of its own ([#50](https://github.com/Vzlentin/workflows/issues/50)) ([348c62f](https://github.com/Vzlentin/workflows/commit/348c62ffb29929a3ad51fbe001a13ca5fff2a613))

## [0.3.4](https://github.com/Vzlentin/workflows/compare/v0.3.3...v0.3.4) (2026-10-24)


### Features

* Herdr workspaces for runs, and workflows attach to open a run session ([#48](https://github.com/Vzlentin/workflows/issues/48)) ([1ae3bc4](https://github.com/Vzlentin/workflows/commit/1ae3bc447d018a8e7ffb95e4e6ef32e8f17fb2f6))

## [0.3.3](https://github.com/Vzlentin/workflows/compare/v0.3.2...v0.3.3) (2026-10-24)


### Features

* add input() to workflow scripts and resume --answer ([7767b09](https://github.com/Vzlentin/workflows/commit/7767b090e97e955098d5494d99c025cc9ac6b6d1))
* add workflows prune for runs whose PR is merged ([88aa18c](https://github.com/Vzlentin/workflows/commit/88aa18cf8822d0463449fe5ab11fe78ce2a20d0a))
* answer a waiting run on the terminal ([fff199c](https://github.com/Vzlentin/workflows/commit/fff199cf2f11f44cc596cf6b285a3b52aab0149f))
* answer waiting runs from the Pi and host workflow tools ([efbf874](https://github.com/Vzlentin/workflows/commit/efbf874087ab110f871191d03e237398c97b6e59))
* give a rundown and ask how to continue when a campaign item fails ([f2f69d6](https://github.com/Vzlentin/workflows/commit/f2f69d6faedcbc9bcd6ca6ea73968a09656b07d1))
* name the campaign branch when the campaign is done ([fe2ff2e](https://github.com/Vzlentin/workflows/commit/fe2ff2e039e4c170993cb1d036f4bea33f64f6a5))
* name the ship commit and branch from a judge turn ([0e3ba4e](https://github.com/Vzlentin/workflows/commit/0e3ba4ee9e155313ec7d00f2c30d6845a0e8f5c7))
* report the run status to the terminal with OSC 7501 ([5c5bf50](https://github.com/Vzlentin/workflows/commit/5c5bf504e919d47348c503eea408fab95e59278c))


### Bug Fixes

* keep run sessions out of the user's memory tools ([6ff0886](https://github.com/Vzlentin/workflows/commit/6ff0886aec0aca9b5bd139807c53cfb74096d4da))

## [0.3.2](https://github.com/Vzlentin/workflows/compare/v0.3.1...v0.3.2) (2026-10-24)


### Features

* research the codebase before the plan in ship ([#43](https://github.com/Vzlentin/workflows/issues/43)) ([02e0d29](https://github.com/Vzlentin/workflows/commit/02e0d29348c48a61bd5f90ed598d1e01c9b1322f))
* run workflows in the background and post the result to the caller ([#45](https://github.com/Vzlentin/workflows/issues/45)) ([7e19a5d](https://github.com/Vzlentin/workflows/commit/7e19a5dcdaa4e6984e2aa1c5d0f8a5ef7cd7e909))

## [0.3.1](https://github.com/Vzlentin/workflows/compare/v0.3.0...v0.3.1) (2026-10-18)


### Bug Fixes

* take harness 0.3 ([#39](https://github.com/Vzlentin/workflows/issues/39)) ([c14b758](https://github.com/Vzlentin/workflows/commit/c14b75848ca7ccb1c1adb89a489587bac3d8a6de))
