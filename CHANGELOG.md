# Changelog

## [0.7.0](https://github.com/Vzlentin/workflows/compare/v0.6.1...v0.7.0) (2026-11-14)


### ⚠ BREAKING CHANGES

* `workflows show --calls` is removed. Use `workflows log <run-id>` to see the calls of a run.
* the package `@vzlentin/workflows` no longer exports `./runs` and `./tool`. Its only export is `./package.json`.
* `list --json` and `show --json` no longer give `caller`, and a run no longer starts the pick loop of `show --pick` and `attach --side` in herdr-app. A run saved by TASK.version 22 does not resume.
* HERDR_ENV and HERDR_PANE_ID have no effect, and runs no longer open Herdr workspaces. Runs saved at TASK.version 21 do not resume.
* requires @vzlentin/harness 0.7.0 and @earendil-works/* 1.5.0.
* .workflows/agents/*.md is no longer read, and TASK.version is 20.
* optimize ship from saved runs with overlays and a blind judge ([#83](https://github.com/Vzlentin/workflows/issues/83))

### Features

* add --repo to judge and thermoloop, and show await on script globals ([febb5a5](https://github.com/Vzlentin/workflows/commit/febb5a5f87d7065d6d60a4fc4277c23cc8326741))
* add `workflows log <run-id>`, which reads a run from the project store ([8a4c1a1](https://github.com/Vzlentin/workflows/commit/8a4c1a1138b621b60218c615fca7dcaccfab7ca7))
* add workflows outline, which prints the outline of a script ([13315ff](https://github.com/Vzlentin/workflows/commit/13315ff07a9713c27bd5f519496704b66e680015))
* add workflows web, a control center of the runs and their agents ([2be6f1d](https://github.com/Vzlentin/workflows/commit/2be6f1d91ef0b7060b51f14b1cee153129ab5fc2))
* export ./runs, show ended runs of earlier versions, and drop workflows web ([bed8d64](https://github.com/Vzlentin/workflows/commit/bed8d64d10a6299e6e25379fade670c9ca6a46a9))
* give the todos of a run and of each child run in show --json ([e91c452](https://github.com/Vzlentin/workflows/commit/e91c4527d8eec2a7215918bf18da33f6a3574155))
* give workflow scripts the todo verbs on the list of their run ([56ca1ff](https://github.com/Vzlentin/workflows/commit/56ca1ffe5810bf2ddb3fabdddf247801a23cdf55))
* judge the shipped commit, keep campaign items at 0, and make roles names ([#93](https://github.com/Vzlentin/workflows/issues/93)) ([fca7a14](https://github.com/Vzlentin/workflows/commit/fca7a14c6c29e13fdd06346d68ec013948361809))
* keep the items of a campaign as todos of its run ([a960156](https://github.com/Vzlentin/workflows/commit/a9601567ff709c43605659cd4c7ee2ae148a2832))
* label run sessions and give a refused campaign item one fix round ([#85](https://github.com/Vzlentin/workflows/issues/85)) ([9fa3eb2](https://github.com/Vzlentin/workflows/commit/9fa3eb23306ae9f9ae03aa8c594336480388d4f7))
* let a script declare its outline in meta.outline, and check it ([2560b91](https://github.com/Vzlentin/workflows/commit/2560b914a6cfc5fe2d98b75985a8f3f69f31db9e))
* make the short log of `workflows log` show steps, and give the calls of one step on request ([e9dc2ce](https://github.com/Vzlentin/workflows/commit/e9dc2ce2e057a5f8677372942119935d2df2e68b))
* move from the Herdr TUI to hc terminals, record the caller, and widen prune ([49e3b7e](https://github.com/Vzlentin/workflows/commit/49e3b7eccc372c079c50fb84d909fa834a477749))
* optimize ship from saved runs with overlays and a blind judge ([#83](https://github.com/Vzlentin/workflows/issues/83)) ([0a7b35b](https://github.com/Vzlentin/workflows/commit/0a7b35b9c285598f76adee3f053e793ed670897c))
* **pi:** `/workflows` picks a run, then an agent, in two Pi selects ([b428987](https://github.com/Vzlentin/workflows/commit/b428987d9a6127eb43b4c798f500f19f42917c6a))
* **pi:** show each workflows run on its own line in the widget ([feedf55](https://github.com/Vzlentin/workflows/commit/feedf555115db1901fdcc7da6b72c3d3c1a0d9ff))
* **pi:** show the workflows widget below the editor, with a header ([e321afb](https://github.com/Vzlentin/workflows/commit/e321afb81f02741fc7843e4947133c88290a20aa))
* point the workflow tool to script.d.ts in place of its script rules ([87ecb17](https://github.com/Vzlentin/workflows/commit/87ecb17724a5aa58e17887ab45b4ad889bb00dd7))
* remove `show --calls`; `workflows log` is the view of the calls ([fe2484c](https://github.com/Vzlentin/workflows/commit/fe2484c0b0933da0ff4dc923d3e6a89c3a507872))


### Bug Fixes

* bound every outcome text that a run gives its caller with one function ([45466f8](https://github.com/Vzlentin/workflows/commit/45466f8560e0efefa5bc9535718ce22ea2976ab0))
* bound the result JSON in the text of a finished run ([819f7ad](https://github.com/Vzlentin/workflows/commit/819f7ad5c2b9ad6d5fb32191f93838e707d1e7ee))
* let the sessions install the dependencies of a fresh worktree ([#88](https://github.com/Vzlentin/workflows/issues/88)) ([7100727](https://github.com/Vzlentin/workflows/commit/710072756b3560dff55bea1371fe6cb68af6641f))
* make the state machines of the workflows engine explicit ([#91](https://github.com/Vzlentin/workflows/issues/91)) ([073308a](https://github.com/Vzlentin/workflows/commit/073308ad51c363c928bd9e07cfdc9f7438786446))
* read meta without a deadline, and make the tests pass on Node 26, Git 2.39 and under load ([bcefbad](https://github.com/Vzlentin/workflows/commit/bcefbad1149eb1ec5ec5edd19744da4005e70466))
* the engine starts no pick loop, and a run saves no `caller` ([9c9eb5b](https://github.com/Vzlentin/workflows/commit/9c9eb5b65e9865e94bee0d11a18104b9b1afef8a))


### Code Refactoring

* move workflows onto the new harness and Pi 1.5.0 ([#92](https://github.com/Vzlentin/workflows/issues/92)) ([8d0e15c](https://github.com/Vzlentin/workflows/commit/8d0e15c8aeaf5b4b7c637e92aed6ef79dd621639))
* the package exports only `./package.json` ([8779180](https://github.com/Vzlentin/workflows/commit/87791807b74c64e03b7152f015b7af2727e99fdb))

## [0.6.1](https://github.com/Vzlentin/workflows/compare/v0.6.0...v0.6.1) (2026-10-31)


### Features

* give commit divergence and run lessons in run results ([#81](https://github.com/Vzlentin/workflows/issues/81)) ([c32cbe3](https://github.com/Vzlentin/workflows/commit/c32cbe35c6a7eb8ae64760a6b2d4e7471e1f42c1))

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
