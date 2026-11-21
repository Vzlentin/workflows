# Changelog

## [0.7.0](https://github.com/Vzlentin/workflows/compare/v0.6.1...v0.7.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* a run session no longer gets the grep, find and ls tools. pi.tool is version 4 in 1.6: a store that 1.6 writes does not open in a 1.5 host.
* let `workflows land` take a branch, a PR number or a run ID
* give every workflow result a `change` with its repository and branch
* make a run serve a work item in place of a project todo
* print the short log of `workflows log` as flat lines with the path of each run
* a run no longer ends `unjudged` and has no `judgeError` field. A judge that fails ends the run `failed`, and `workflows resume` judges again.
* replace `parent` with `driver`, the conversation that started or resumed the current task
* `runStatus` in src/run/past.ts now gives `earlier-version` or `later-version` for every task of another version, also when it ended. In the JSON of `list` and `show`, each old run moves from `done`, `waiting` or `failed` to `earlier-version`. Before, only a task that had not ended got that state. The `resumable` field of `list` and `show` is gone: it repeated the state, and `earlier-version` and `later-version` are the states that cannot resume.
* `workflows prune` is removed: use `workflows sweep`. A post-merge hook that runs `workflows prune --yes` must run `workflows sweep --yes`. The text line and the JSON entry of a swept run add the word. A `pruning` marker of an interrupted prune is not read.
* `list --pick` is removed: use `show --pick`. In an hc terminal, `attach` without `--side` runs Pi in this terminal, and does not open a herdr-app tab. `prune` does not remove hc terminals. A project script with the name of a command fails every command that loads the scripts.
* tighten the script contract: reserve background, restrict meta.exit, check the result, and expose only declared lib helpers
* an entry of workflows outline --json gives the outline in outline, not steps, and has the new fields.
* give list and show JSON one schema each, with the model, question, branch, start time, serves and agent of a run
* make the input of a run an ask of the host, and let only an open input() call make a run wait
* the JSON of list, show, the command outcome, the catch-up hook and the workflow tool replaces `status` with `state` and `result`. A ship or a campaign whose last judge gives 0 or fails now exits 1.
* `workflows show --calls` is removed. Use `workflows log <run-id>` to see the calls of a run.
* the package `@vzlentin/workflows` no longer exports `./runs` and `./tool`. Its only export is `./package.json`.
* `list --json` and `show --json` no longer give `caller`, and a run no longer starts the pick loop of `show --pick` and `attach --side` in herdr-app. A run saved by TASK.version 22 does not resume.
* HERDR_ENV and HERDR_PANE_ID have no effect, and runs no longer open Herdr workspaces. Runs saved at TASK.version 21 do not resume.
* requires @vzlentin/harness 0.7.0 and @earendil-works/* 1.5.0.
* .workflows/agents/*.md is no longer read, and TASK.version is 20.
* optimize ship from saved runs with overlays and a blind judge ([#83](https://github.com/Vzlentin/workflows/issues/83))

### Features

* `workflows log` shows the error of a failed run ([f96aca2](https://github.com/Vzlentin/workflows/commit/f96aca2237b3704feba799e885792c99f381b80f))
* add --repo to judge and thermoloop, and show await on script globals ([febb5a5](https://github.com/Vzlentin/workflows/commit/febb5a5f87d7065d6d60a4fc4277c23cc8326741))
* add `land`, a workflow that lands the branch of a run and refuses a red branch ([161f471](https://github.com/Vzlentin/workflows/commit/161f471fbc0d33985a13dc4732c785bcbf4eda33))
* add `steps` to `workflows list --json` and `agents` to `workflows show <id> --json` ([a0d838f](https://github.com/Vzlentin/workflows/commit/a0d838f8c181bf4c4adb890890cf84830b9ba2eb))
* add `workflows log <run-id>`, which reads a run from the project store ([8a4c1a1](https://github.com/Vzlentin/workflows/commit/8a4c1a1138b621b60218c615fca7dcaccfab7ca7))
* add workflows outline, which prints the outline of a script ([13315ff](https://github.com/Vzlentin/workflows/commit/13315ff07a9713c27bd5f519496704b66e680015))
* add workflows web, a control center of the runs and their agents ([2be6f1d](https://github.com/Vzlentin/workflows/commit/2be6f1d91ef0b7060b51f14b1cee153129ab5fc2))
* ask the judge for every finding of the change in one pass ([a2abfc2](https://github.com/Vzlentin/workflows/commit/a2abfc2da3e206c3aab3ed62d2977151070434be))
* close the item of a merged run in `workflows sweep` ([69b3745](https://github.com/Vzlentin/workflows/commit/69b3745942fbd5cbb5d890daa3d247240c35d785))
* count flaky tests as review findings, and skip commit messages ([f5b5022](https://github.com/Vzlentin/workflows/commit/f5b5022fa9be44c5c31a3b2ddbef8ca032a3777e))
* export ./runs, show ended runs of earlier versions, and drop workflows web ([bed8d64](https://github.com/Vzlentin/workflows/commit/bed8d64d10a6299e6e25379fade670c9ca6a46a9))
* fail the run when the judge fails, and remove the `unjudged` status ([8f62824](https://github.com/Vzlentin/workflows/commit/8f62824fcf1e9c1a2aecb9937cec195e9a186d5c))
* fail with a clear error when the `[@earendil-works](https://github.com/earendil-works)` versions of harness and workflows differ ([bf11f12](https://github.com/Vzlentin/workflows/commit/bf11f126902bf1b0e6a80fa7663b3c0368b1949a))
* give a run of another version its own state, and end `wait`, the watcher and `stop` on it once ([9c04a34](https://github.com/Vzlentin/workflows/commit/9c04a34934bbc72b790f01cd7d10bf982c5882cb))
* give each run output a state and a result, and exit 1 when the last judge gives 0 or fails ([73f3c02](https://github.com/Vzlentin/workflows/commit/73f3c029a8e4c08190a24d79bed83ef724be912f))
* give every workflow result a `change` with its repository and branch ([25635df](https://github.com/Vzlentin/workflows/commit/25635dfcd496d8490b84abcd51134af536fcc381))
* give list and show JSON one schema each, with the model, question, branch, start time, serves and agent of a run ([827192b](https://github.com/Vzlentin/workflows/commit/827192b00baf503d4b56b2dd30221f7d9aaab8c2))
* give the checked meta of every script in workflows outline --json, with an error entry for a bad meta ([5804cd2](https://github.com/Vzlentin/workflows/commit/5804cd23f02d5405f4928da41e3dc02bcb3ef661))
* give the log step name of each step line in `show --json` ([fc834d9](https://github.com/Vzlentin/workflows/commit/fc834d9e6387acab8bbb2e5a77dc20f57fb46b64))
* give the todos of a run and of each child run in show --json ([e91c452](https://github.com/Vzlentin/workflows/commit/e91c4527d8eec2a7215918bf18da33f6a3574155))
* give the work item file of a run as `item` in `list --json` and `show --json` ([f3e6329](https://github.com/Vzlentin/workflows/commit/f3e6329dbbdcef1e0578ec918c58235c8dba85b6))
* give workflow scripts the `workflows` command of this package ([33b11b8](https://github.com/Vzlentin/workflows/commit/33b11b89e91113797c50da00a1b1dff384602d53))
* give workflow scripts the todo verbs on the list of their run ([56ca1ff](https://github.com/Vzlentin/workflows/commit/56ca1ffe5810bf2ddb3fabdddf247801a23cdf55))
* judge the shipped commit, keep campaign items at 0, and make roles names ([#93](https://github.com/Vzlentin/workflows/issues/93)) ([fca7a14](https://github.com/Vzlentin/workflows/commit/fca7a14c6c29e13fdd06346d68ec013948361809))
* keep a bounded tail of the output of a failed `sh` call in its record ([d932f83](https://github.com/Vzlentin/workflows/commit/d932f8324a95b3bc76f55e6309c7e1ff7035536c))
* keep the items of a campaign as todos of its run ([a960156](https://github.com/Vzlentin/workflows/commit/a9601567ff709c43605659cd4c7ee2ae148a2832))
* label run sessions and give a refused campaign item one fix round ([#85](https://github.com/Vzlentin/workflows/issues/85)) ([9fa3eb2](https://github.com/Vzlentin/workflows/commit/9fa3eb23306ae9f9ae03aa8c594336480388d4f7))
* land an approved thermoloop run with `workflows land` ([f1c8fe5](https://github.com/Vzlentin/workflows/commit/f1c8fe599b41ae3814b2fe59fba1836f8405c9fb))
* let `workflows land` take a branch, a PR number or a run ID ([3ddffa1](https://github.com/Vzlentin/workflows/commit/3ddffa1a0d920e27d71f02b6034d60383e751490))
* let `workflows sweep` take a branch or any run ID ([1427e48](https://github.com/Vzlentin/workflows/commit/1427e48a22c8030c4f985b89227f77ec8f2b2460))
* let a script declare its outline in meta.outline, and check it ([2560b91](https://github.com/Vzlentin/workflows/commit/2560b914a6cfc5fe2d98b75985a8f3f69f31db9e))
* let the workflow tool start a run in another directory ([c410818](https://github.com/Vzlentin/workflows/commit/c410818a746dbc01fa819c4ed542e6db00867a02))
* make a run serve a work item in place of a project todo ([b734b5e](https://github.com/Vzlentin/workflows/commit/b734b5ee08c0c9876f244e49e4165b330fabc947))
* make the input of a run an ask of the host, and let only an open input() call make a run wait ([d55c7f9](https://github.com/Vzlentin/workflows/commit/d55c7f9e1153cff46ef84a4956ada9fad8e60f40))
* make the short log of `workflows log` show steps, and give the calls of one step on request ([e9dc2ce](https://github.com/Vzlentin/workflows/commit/e9dc2ce2e057a5f8677372942119935d2df2e68b))
* move from the Herdr TUI to hc terminals, record the caller, and widen prune ([49e3b7e](https://github.com/Vzlentin/workflows/commit/49e3b7eccc372c079c50fb84d909fa834a477749))
* move to [@earendil-works](https://github.com/earendil-works) 1.6 and the harness with pi-durable child tools ([238b34d](https://github.com/Vzlentin/workflows/commit/238b34df71f1401507f138b6dcfebaa523dbec05))
* optimize ship from saved runs with overlays and a blind judge ([#83](https://github.com/Vzlentin/workflows/issues/83)) ([0a7b35b](https://github.com/Vzlentin/workflows/commit/0a7b35b9c285598f76adee3f053e793ed670897c))
* **pi:** `/workflows` picks a run, then an agent, in two Pi selects ([b428987](https://github.com/Vzlentin/workflows/commit/b428987d9a6127eb43b4c798f500f19f42917c6a))
* **pi:** show each workflows run on its own line in the widget ([feedf55](https://github.com/Vzlentin/workflows/commit/feedf555115db1901fdcc7da6b72c3d3c1a0d9ff))
* **pi:** show the workflows widget below the editor, with a header ([e321afb](https://github.com/Vzlentin/workflows/commit/e321afb81f02741fc7843e4947133c88290a20aa))
* point the workflow tool to script.d.ts in place of its script rules ([87ecb17](https://github.com/Vzlentin/workflows/commit/87ecb17724a5aa58e17887ab45b4ad889bb00dd7))
* print the short log of `workflows log` as flat lines with the path of each run ([7614492](https://github.com/Vzlentin/workflows/commit/7614492ccd0d810fd5ab13e8feec9a248127de97))
* read the agents tables again on resume, and move the sessions of the run to them ([7388829](https://github.com/Vzlentin/workflows/commit/73888298d6f8663dd89ae5111111d0fdfa0f1955))
* refuse a script with a command name, keep one picker in show --pick, and let harness attach open the agent ([610e3be](https://github.com/Vzlentin/workflows/commit/610e3be4f783d579e5216e27005184c38579917e))
* remove `show --calls`; `workflows log` is the view of the calls ([fe2484c](https://github.com/Vzlentin/workflows/commit/fe2484c0b0933da0ff4dc923d3e6a89c3a507872))
* replace `parent` with `driver`, the conversation that started or resumed the current task ([a45161c](https://github.com/Vzlentin/workflows/commit/a45161ccd7e3f4b1a7430b77886337402040031b))
* replace workflows prune with workflows sweep, which writes landed or dropped into each run that it sweeps ([5a43ad1](https://github.com/Vzlentin/workflows/commit/5a43ad1f9b5aec2f7c51ab03e8d48beae5571176))
* run thermoloop and judge in the worktree that has the branch of the change ([f135b79](https://github.com/Vzlentin/workflows/commit/f135b79e2b8e3b81dc2295cce26426d7508729c1))
* say in the workflow tool description when a run may start ([5de231e](https://github.com/Vzlentin/workflows/commit/5de231ed3a2fd146e2598f6ba3df8fe22da10733))
* show the repository of each background run in the Pi widget ([1ee0831](https://github.com/Vzlentin/workflows/commit/1ee083190e0ee083e83012ab6e6068370f4d9dd6))
* size the items of a campaign split with the batch-size trade-off ([182addc](https://github.com/Vzlentin/workflows/commit/182addc1a0bffea59a308710beda86a5d67719ab))
* tighten the script contract: reserve background, restrict meta.exit, check the result, and expose only declared lib helpers ([efe671c](https://github.com/Vzlentin/workflows/commit/efe671c417000224139125ec51c27ab98616ee87))


### Bug Fixes

* align the review and judge prompts on scope and 1,000-line splits ([bdacee3](https://github.com/Vzlentin/workflows/commit/bdacee38344df34522701b83383a529b59162a7e))
* bound every outcome text that a run gives its caller with one function ([45466f8](https://github.com/Vzlentin/workflows/commit/45466f8560e0efefa5bc9535718ce22ea2976ab0))
* bound the output in the error text of a failed command ([b7ed9c7](https://github.com/Vzlentin/workflows/commit/b7ed9c792ac139c5e2b9f4430ab62299db6072e0))
* bound the result JSON in the text of a finished run ([819f7ad](https://github.com/Vzlentin/workflows/commit/819f7ad5c2b9ad6d5fb32191f93838e707d1e7ee))
* clear a stale worktree registration when Git lists it at another path ([d4bd9ce](https://github.com/Vzlentin/workflows/commit/d4bd9ce163fec9f0636b2d16ca39cd36d733c987))
* close the stdin of the commands of `sh`, `ok` and `git()` ([1183c71](https://github.com/Vzlentin/workflows/commit/1183c71e634a5d0c47b582ca201fcf07b2ecaeef))
* follow a background run from its `run <id>` line, so a cut call keeps its result ([402dad8](https://github.com/Vzlentin/workflows/commit/402dad81952048a280c4fb93e4d9196a54951b61))
* give the change of its checkout to an rpi that runs in its caller's place ([522901a](https://github.com/Vzlentin/workflows/commit/522901a07d0cd14b6bd1029ecad23f0c4f1c4e96))
* give the sessions of a run no harness store tools, on harness main 3e50ec4 ([412c2c0](https://github.com/Vzlentin/workflows/commit/412c2c0b1bdafa5052387c1d3a736531288e2724))
* keep findings, divergence and waiting questions whole in the `workflow` tool text ([e5ed65e](https://github.com/Vzlentin/workflows/commit/e5ed65e3d6367f52f12b820dc4522e9a77883acc))
* keep the worktree and the branch of a run safe at each task ([716dbc0](https://github.com/Vzlentin/workflows/commit/716dbc092d1bf4791c1c270ec24cd68f8763ca87))
* key a memory note by its line, not by the order of the adds ([92311a9](https://github.com/Vzlentin/workflows/commit/92311a99ccd3077097592a86ff9acb67ea3070cb))
* key the session of `agent` by its prompt, and let `session` take a `key` ([77a0f40](https://github.com/Vzlentin/workflows/commit/77a0f40049dd53dfbb97385412b5bc9752a1a1ed))
* let the sessions install the dependencies of a fresh worktree ([#88](https://github.com/Vzlentin/workflows/issues/88)) ([7100727](https://github.com/Vzlentin/workflows/commit/710072756b3560dff55bea1371fe6cb68af6641f))
* lock down `Date` and `Math.random` also through `globalThis` ([4d7ed01](https://github.com/Vzlentin/workflows/commit/4d7ed016166d51e1ae3de3a76dbe89b47af66dcd))
* make commitAll, the optimize cleanup and the OptMem note safe to run again ([64f3440](https://github.com/Vzlentin/workflows/commit/64f34407942e3e9ab6ce055484557102c877e25c))
* make the state machines of the workflows engine explicit ([#91](https://github.com/Vzlentin/workflows/issues/91)) ([073308a](https://github.com/Vzlentin/workflows/commit/073308ad51c363c928bd9e07cfdc9f7438786446))
* one live task for each run when two resumes race ([850efd8](https://github.com/Vzlentin/workflows/commit/850efd8d7c935691cb2442dc019439db58be4bdf))
* post the outcome of a background run in the commit that ends its task ([3d1285a](https://github.com/Vzlentin/workflows/commit/3d1285a9c25963c90584a00b8558207e6ec56a65))
* prune removes only what is safe to remove ([da55a96](https://github.com/Vzlentin/workflows/commit/da55a967eb851b9ba944bb2b344245446e6b34df))
* read a bare local branch as that branch wherever it is checked out ([5c525c4](https://github.com/Vzlentin/workflows/commit/5c525c4f6630d7e733ffa5bfd77385af7e1a503b))
* read a memo request only from the end of its output ([c7c093e](https://github.com/Vzlentin/workflows/commit/c7c093e8f7fda8fa8e23dd4c46aefa25224fe01a))
* read meta without a deadline, and make the tests pass on Node 26, Git 2.39 and under load ([bcefbad](https://github.com/Vzlentin/workflows/commit/bcefbad1149eb1ec5ec5edd19744da4005e70466))
* remove the memory sentence from the instructions of a run session ([bccdb86](https://github.com/Vzlentin/workflows/commit/bccdb861f1a6c52f46f565fbfc03d2e917649ce1))
* save a caught failure of `ask` or `sh` with `settle`, and report the commit message fallback ([1263de4](https://github.com/Vzlentin/workflows/commit/1263de40a61435a14881b66bbd2cf2e309a5598c))
* state no time in the campaign split prompt ([795f369](https://github.com/Vzlentin/workflows/commit/795f369164f8fec8b4d78f9b567bc799e5502b6d))
* stop the Git command of a script step when the run stops ([c229525](https://github.com/Vzlentin/workflows/commit/c229525abf91e0bbdff7680ba25e49ad15e903c9))
* sweep a run that is on the local main without asking gh ([a5126b3](https://github.com/Vzlentin/workflows/commit/a5126b34f6b4ed97004affbcdc2d794effb49d60))
* the engine starts no pick loop, and a run saves no `caller` ([9c9eb5b](https://github.com/Vzlentin/workflows/commit/9c9eb5b65e9865e94bee0d11a18104b9b1afef8a))


### Performance Improvements

* import `@earendil-works/pi-coding-agent` only in `workflows check` ([9fac9b8](https://github.com/Vzlentin/workflows/commit/9fac9b8db1af82bd3db3aeed55066b8e93971bfb))
* read only the call records of a run and its child runs by key prefix ([777ebe1](https://github.com/Vzlentin/workflows/commit/777ebe151146fbc171e1c82dc5686bda0d866477))
* read root run tasks through `startedTasks` and live tasks by status ([624930b](https://github.com/Vzlentin/workflows/commit/624930b46f9131b46c45f6fd9f429e61650b3939))


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
