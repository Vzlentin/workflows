import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { REMINDER } from "@vzlentin/harness/answer";
import { connect } from "@vzlentin/harness/client";
import { entriesPath } from "@vzlentin/harness/entries";
import { type Host, runHost } from "@vzlentin/harness/host";
import { projectDir } from "@vzlentin/harness/projects";
import { AGENT_HANDLE, type Replies, type Request, statePaths } from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { main } from "../src/main.ts";
import { CtrlC } from "../src/run.ts";

/** The entry of the workflows checkout, which the hosts of the tests load. */
export const ENTRY = fileURLToPath(new URL("../src/entry.ts", import.meta.url));

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

const ENVIRONMENT = { ...process.env };

/** The run directories of the sandbox `root`. */
export const runsOf = (root: string) => join(root, "state", "workflows", "runs");

/** The line that a command prints when Ctrl+C detaches it from the run `id`. */
export const detached = (id: string | undefined) =>
	`detached; run ${id} goes on. Follow it with: workflows resume ${id}. Stop it with: workflows stop ${id}`;

/** The project store of `project` in the sandbox. */
export const storeOf = (project = "main") => join(statePaths(project).dir, "durable.sqlite");

/** The `workflows.run` tasks in the store of `project`. */
async function runTasks(project: string) {
	const storage = await openNodeSqliteStorage(storeOf(project));

	try {
		const { items } = await storage.scanTasks({}, 256, undefined, BACKGROUND_CONTEXT);

		return items.filter((task) => task.kind === "workflows.run");
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

const RUN_ID = Type.Object({ runId: Type.String() });
const CHILD_INPUT = Type.Object({ runId: Type.String(), root: Type.String() });

const stateOf = ({ state }: Awaited<ReturnType<typeof runTasks>>[number]) =>
	state.status === "terminal" ? { status: state.status, outcome: state.outcome.status } : { status: state.status };

/** The state of each task of the run `id` of `project` that no task owns. */
export async function rootTasks(id: string, project = "main") {
	return (await runTasks(project))
		.filter((task) => task.owner === undefined && Value.Check(RUN_ID, task.input) && task.input.runId === id)
		.map(stateOf);
}

/** The run ID and the state of each task of a child run of the run `id` of the `main` project. */
export async function childTasks(id: string) {
	return (await runTasks("main")).flatMap((task) =>
		task.owner !== undefined && Value.Check(CHILD_INPUT, task.input) && task.input.root === id
			? [{ runId: task.input.runId, ...stateOf(task) }]
			: [],
	);
}

/** Writes Pi's settings of the sandbox `root`: the Pi packages `packages`, and `settings`. */
export async function piSettings(
	root: string,
	packages: readonly string[] = [],
	settings: { readonly [key: string]: JsonValue } = {},
): Promise<void> {
	await writeFile(
		join(root, "agent", "settings.json"),
		JSON.stringify({ retry: { enabled: false }, ...settings, packages }),
	);
}

/** Writes harness's entries of the sandbox: the workflows checkout and `entries`, by name. */
export async function setEntries(entries: Readonly<Record<string, string>> = {}): Promise<void> {
	await mkdir(dirname(entriesPath()), { recursive: true });
	await writeFile(entriesPath(), JSON.stringify({ workflows: ENTRY, ...entries }));
}

/**
 * A fresh environment: home, state, configuration, Pi agent and Git configuration under a temporary directory, and a
 * fake `gh`. harness's entries list the workflows checkout, so the test hosts load its entry.
 */
export async function sandbox(): Promise<string> {
	// macOS limits a Unix socket path to 104 bytes, and the host's socket is in the state directory.
	const root = await mkdtemp("/tmp/wf-");
	const bin = join(root, "bin");
	await mkdir(bin);
	await mkdir(join(root, "agent"));
	await mkdir(join(root, "home"));
	await writeFile(join(root, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
	await piSettings(root);
	await writeFile(
		join(bin, "gh"),
		`#!/bin/sh
echo "$@" >> "${root}/gh.log"
[ "$1 $2" = "repo clone" ] || exit 1
case "$3" in */*) source="$3" ;; *) source="octocat/$3" ;; esac
[ -d "${root}/github/$source" ] || { echo "GraphQL: Could not resolve to a Repository" >&2; exit 1; }
exec git clone -q "${root}/github/$source" "$4"
`,
	);
	await chmod(join(bin, "gh"), 0o755);
	process.env = {
		...ENVIRONMENT,
		HOME: join(root, "home"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_CONFIG_HOME: join(root, "config"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		PATH: `${bin}:${ENVIRONMENT.PATH}`,
	};

	for (const name of [
		"HARNESS_PROJECT",
		// This would make `prune` call the real herdr.
		"HERDR_ENV",
		"PI_SESSION_ID",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
		// Node warns on stderr when both are set, and the tests compare stderr.
		"FORCE_COLOR",
		"NO_COLOR",
	]) {
		delete process.env[name];
	}

	await setEntries();

	return root;
}

/** A repository at `path` with one commit of README.md on main. */
export async function repository(path: string, readme = "# Demo\n\nHello wrold\n"): Promise<string> {
	await mkdir(path, { recursive: true });
	git(path, "init", "-q", "-b", "main");
	await writeFile(join(path, "README.md"), readme);
	git(path, "add", "README.md");
	git(path, "commit", "-q", "-m", "initial");

	return git(path, "rev-parse", "HEAD");
}

export type Kind =
	| "plan"
	| "challenge"
	| "handoff"
	| "implement"
	| "research"
	| "review"
	| "verdict"
	| "judge"
	| "commit"
	| "split"
	| "requeue"
	| "branch"
	| "reflect"
	| "script"
	| "result";

/** One answered prompt: its kind, provider, model, thinking level, offered tools, system prompt sections, and text. */
export type Call = {
	readonly kind: Kind;
	readonly provider: string;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly tools: readonly string[];
	readonly sections: Readonly<Record<string, string | null>>;
	readonly prompt: string;
};

/** The leading run memory of a ship prompt. */
const MEMORY = /^## memory\n[\s\S]*?\n\n/;

const KINDS: readonly (readonly [string, Kind])[] = [
	["Research the codebase", "research"],
	["Plan this change.", "plan"],
	["Challenge the plan", "challenge"],
	["Write a handoff document", "handoff"],
	["Implement this plan", "implement"],
	["Perform a deep code quality audit", "review"],
	["## Vocabulary", "judge"],
	["Write the commit message and the branch name", "commit"],
	["Split this goal into work items.", "split"],
	["Update the work item queue", "requeue"],
	["Name the branch of this campaign", "branch"],
	["Improve this prompt", "reflect"],
	["Script", "script"],
	// The outcome that a background run posts to the conversation of its `workflow` call.
	["run ", "result"],
];

function textOf(message: Message): string {
	if (message.role === "system") return "";
	const { content } = message;

	if (!Array.isArray(content)) return content;

	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export type Script = {
	/** Each implement turn commits its edit itself with bash. */
	readonly commits?: boolean;
	/** README.md after each implement turn; undefined changes nothing. */
	readonly edits?: readonly (string | undefined)[];
	/** The review verdict of each round. */
	readonly verdicts?: readonly ("SHIP" | "FIX")[];
	/** The judge's `respond` answer, or a text reply without `respond`; a list gives one for each judge call. */
	readonly judge?: Verdict | string | readonly (Verdict | string)[];
	/** The `respond` answer of the commit message turn; a list gives one for each commit call. */
	readonly commit?: Commit | readonly Commit[];
	/** The work items of the split answer. */
	readonly items?: readonly string[];
	/** The queue of each requeue answer; a missing answer is an empty queue. */
	readonly queues?: readonly (readonly string[])[];
	/** The `respond` answer of the campaign branch turn. */
	readonly branch?: string;
	/** The prompt that interrupts the run: Ctrl+C is pressed while it waits for its answer. */
	readonly interruptAt?: { readonly kind: Kind; readonly nth: number };
	/**
	 * The prompt that the provider answers with an error, once: a retry of it is answered. With `stopReason`, the
	 * provider answers a cut text that stopped for that reason instead.
	 */
	readonly failAt?: { readonly kind: Kind; readonly nth: number; readonly stopReason?: "length" };
	/** The plan prompt first calls `probe` and `ls`, review and judge call `probe`, and implement calls `probe` next to its edit. */
	readonly probe?: boolean;
	/** A prompt whose requests this model never answers: they wait until they are aborted. */
	readonly hang?: string;
	/** How many answers of this model to `Script respond: <json>` prompts are text replies with no `respond` call. */
	readonly skipRespond?: number;
	/** Ctrl+C: `abort` presses it, and `signal` aborts at the first press. */
	readonly interrupt: { readonly signal: AbortSignal; abort(): void };
};

export type Verdict = { readonly answers: readonly ("PASS" | "FAIL")[]; readonly findings: readonly string[] };

export const PASSING_JUDGE: Verdict = {
	answers: ["PASS", "PASS", "PASS", "FAIL", "PASS", "PASS", "PASS", "PASS"],
	findings: ["4 FAIL README.md:3 adds a line the work item does not need"],
};

export type Commit = { readonly branch: string; readonly subject: string; readonly body: string };

export const COMMIT: Commit = {
	branch: "fix/readme-typo",
	subject: "fix: correct the README typo",
	body: "The README said wrold. It now says world.",
};

/**
 * A scripted model for the `anthropic` and `other` providers. It records every prompt it answers. After Ctrl+C it
 * answers nothing: a request waits until the host closes.
 */
export class FakeModel {
	readonly calls: Call[] = [];
	/** The text of every tool result the model received. */
	readonly results: string[] = [];
	/** The prompts of the requests that waited after Ctrl+C or for `hang`, and of those that were aborted. */
	readonly waiting: string[] = [];
	readonly aborted: string[] = [];
	readonly models = createModels();
	readonly #script: Script;
	#failed = false;
	#skipped = 0;

	constructor(script: Script) {
		this.#script = script;

		const anthropic = fauxProvider({
			provider: "anthropic",
			models: [
				{ id: "claude-opus-5-5", reasoning: true },
				{ id: "claude-haiku-5", reasoning: true },
			],
		});

		const other = fauxProvider({ provider: "other", models: [{ id: "o-1", reasoning: true }] });

		for (const faux of [anthropic, other]) {
			faux.setResponses(Array.from({ length: 200 }, () => this.#respond));
			this.models.setProvider(faux.provider);
		}
	}

	count(kind: Kind): number {
		return this.calls.filter((call) => call.kind === kind).length;
	}

	find(kind: Kind, nth = 0): Call | undefined {
		return this.calls.filter((call) => call.kind === kind)[nth];
	}

	readonly #respond: FauxResponseFactory = async (context, options, _state, model) => {
		const messages = context.messages;
		const system = messages.flatMap((message) => (message.role === "system" ? [message] : []));
		const tools: string[] = [];

		for (const message of system) {
			const removed = new Set((message.toolsRemoved ?? []).map((tool) => tool.name));
			tools.splice(0, tools.length, ...tools.filter((name) => !removed.has(name)));
			tools.push(...(message.toolsAdded ?? []).map((tool) => tool.name));
		}

		const index = asked(messages);
		const user = messages[index];
		// harness puts `Task:` before the prompt of a spawned subagent.
		const prompt = user === undefined ? "" : textOf(user).replace(/^Task:\n/, "");
		const lastUser = messages.findLast((message) => message.role === "user");
		const found = KINDS.find(([start]) => prompt.replace(MEMORY, "").startsWith(start))?.[1];

		if (found === undefined) throw new Error(`unexpected prompt: ${prompt}`);
		const kind = found === "challenge" && tools.includes("respond") ? "verdict" : found;
		const last = messages.findLast((message) => message.role !== "system");

		if (last?.role === "toolResult") {
			const after = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);

			for (const message of after) if (message.role === "toolResult") this.results.push(textOf(message));
			const scripted = scriptAttempt(messages, index);

			if (scripted !== undefined) return scripted;

			if (kind === "judge") return this.#judge();

			if (kind === "implement") return implemented(this.count(kind), "I fixed the typo in README.md.");

			return fauxAssistantMessage("I fixed the typo in README.md.");
		}

		const nth = this.count(kind) + 1;
		const { interruptAt, interrupt } = this.#script;

		if (interruptAt?.kind === kind && interruptAt.nth === nth) interrupt.abort();

		if (interrupt.signal.aborted || prompt === this.#script.hang) {
			this.waiting.push(prompt);
			await new Promise((_, reject) =>
				options?.signal?.addEventListener("abort", () => {
					this.aborted.push(prompt);
					reject(new Error("aborted"));
				}),
			);
		}

		const { failAt } = this.#script;

		if (failAt?.kind === kind && failAt.nth === nth && !this.#failed) {
			this.#failed = true;

			if (failAt.stopReason !== undefined) return fauxAssistantMessage("cut", { stopReason: failAt.stopReason });

			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
		}

		this.calls.push({
			kind,
			provider: model.provider,
			model: model.id,
			thinking: options?.reasoning,
			tools,
			sections: Object.assign({}, ...system.map((message) => message.sections ?? {})),
			prompt: lastUser === undefined ? "" : textOf(lastUser),
		});
		const probe = fauxToolCall("probe", {});

		if (this.#script.probe && kind === "plan") {
			return fauxAssistantMessage([probe, fauxToolCall("ls", {})], { stopReason: "toolUse" });
		}

		if (this.#script.probe && (kind === "review" || kind === "judge")) {
			return fauxAssistantMessage(probe, { stopReason: "toolUse" });
		}

		switch (kind) {
			case "research":
				return fauxAssistantMessage("Summary: README.md:1 says wrold.");
			case "plan":
				return fauxAssistantMessage("Problem: README.md says wrold.");
			case "challenge":
				return fauxAssistantMessage("Keep: one word changes.");
			case "handoff":
				return respond({
					text: `Handoff ${nth}: replace wrold with world in README.md.`,
					notes: [`Handoff ${nth}: one word\n changes.`, " "],
				});
			case "implement": {
				const edit = this.#script.edits?.[nth - 1];

				if (edit === undefined) return implemented(nth, "I found nothing to change.");

				const call = this.#script.commits
					? fauxToolCall("bash", {
							command: `printf '%s' '${edit}' > README.md && git commit -qam 'implementer ${nth}'`,
						})
					: fauxToolCall("write", { path: "README.md", content: edit });

				return fauxAssistantMessage(this.#script.probe ? [call, probe] : call, { stopReason: "toolUse" });
			}

			case "review":
				return fauxAssistantMessage(`Review ${nth}: the change is small.`);
			case "verdict":
				return respond(this.#script.verdicts?.[nth - 1] ?? "SHIP");
			case "judge":
				return this.#judge();
			case "commit":
				return this.#commit();
			case "split":
				return respond({ items: [...(this.#script.items ?? [])] });
			case "requeue":
				return respond({ items: [...(this.#script.queues?.[nth - 1] ?? [])] });
			case "branch":
				return respond({ branch: this.#script.branch ?? "docs/readme" });
			case "reflect": {
				// The reply keeps the current text first, so that the prompt keeps its kind.
				const current = /\n## current\n([\s\S]*?)\n\n## records\n/.exec(prompt)?.[1] ?? "";

				return fauxAssistantMessage(`${current}\nImproved prompt ${nth}.`);
			}

			case "result":
				return fauxAssistantMessage("Noted.");
			case "script": {
				// `Script spawn: <prompt>` spawns a subagent with the prompt `Script: <prompt>` through harness's tool.
				const spawned = /^Script spawn: (.*)$/s.exec(prompt)?.[1];

				if (spawned !== undefined) {
					const spawn = fauxToolCall("subagent", { action: "spawn", prompts: [`Script: ${spawned}`] });

					return fauxAssistantMessage(spawn, { stopReason: "toolUse" });
				}

				// `Script workflow: <json>` calls the `workflow` tool with the args <json>; a spawned subagent gets `Script: workflow: <json>`.
				const workflow = /^Script:? workflow: (.*)$/s.exec(prompt)?.[1];

				if (workflow !== undefined) {
					return fauxAssistantMessage(fauxToolCall("workflow", JSON.parse(workflow)), { stopReason: "toolUse" });
				}

				// `respond` and a tool call in one message: the tool result then gets a text reply that ends the turn.
				const both = /^Script respond and ls: (.*)$/s.exec(prompt)?.[1];

				if (both !== undefined) {
					const calls = [fauxToolCall("respond", { answer: JSON.parse(both) }), fauxToolCall("ls", {})];

					return fauxAssistantMessage(calls, { stopReason: "toolUse" });
				}

				if (prompt.startsWith("Script respond: ") && this.#skipped < (this.#script.skipRespond ?? 0)) {
					this.#skipped++;

					return fauxAssistantMessage("Plain reply");
				}

				return scriptAttempt(messages, index) ?? fauxAssistantMessage(`Reply to ${prompt.slice("Script: ".length)}`);
			}
		}
	};

	#judge(): AssistantMessage {
		const { judge: scripted = PASSING_JUDGE } = this.#script;
		const judge = Array.isArray(scripted) ? (scripted[this.count("judge") - 1] ?? PASSING_JUDGE) : scripted;

		return Value.Check(Type.String(), judge) ? fauxAssistantMessage(judge) : respond(judge);
	}

	#commit(): AssistantMessage {
		const { commit: scripted = COMMIT } = this.#script;

		return respond(Array.isArray(scripted) ? (scripted[this.count("commit") - 1] ?? COMMIT) : scripted);
	}
}

/** The index of the last user message that is not a reminder to call `respond`. */
function asked(messages: readonly Message[]): number {
	return messages.findLastIndex((message) => message.role === "user" && textOf(message) !== REMINDER);
}

/**
 * The `respond` call of the current attempt at the `Script respond: <json>` prompt at index `user` of `messages`, which has one JSON text per line:
 * attempt n answers with line n. Undefined for any other prompt, whose reply is `Reply to <text>`.
 */
function scriptAttempt(messages: readonly Message[], user: number): AssistantMessage | undefined {
	const prompt = messages[user];
	const answers = prompt && /^Script respond: (.*)$/s.exec(textOf(prompt))?.[1]?.split("\n");

	if (answers === undefined) return undefined;
	const tried = messages.slice(user).filter((message) => message.role === "toolResult").length;
	const answer = answers[tried];

	if (answer === undefined) throw new Error(`no scripted answer for attempt ${tried + 1}`);

	return respond(JSON.parse(answer));
}

function respond(answer: ToolCall["arguments"][string]): AssistantMessage {
	return fauxAssistantMessage(fauxToolCall("respond", { answer }), { stopReason: "toolUse" });
}

/** The `respond` answer of the nth implement turn. */
function implemented(nth: number, reply: string): AssistantMessage {
	return respond({ text: reply, notes: [`Implement ${nth}: README.md had wrold.`] });
}

export type Outcome = {
	readonly code: number;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
	readonly model: FakeModel;
	readonly id: string | undefined;
	/** The host of the command, with `keepHost`. */
	readonly host: Host | undefined;
	/** The Ctrl+C presses that would make the real command exit. */
	readonly exits: number;
};

const PROGRESS = Type.Object({ progress: Type.Array(Type.String()) });

/** The lines of the last `{"progress":[...]}` stderr line of a `--json` run, and throws for any other stderr line. */
export function progressOf(stderr: readonly string[]): string[] {
	const snapshots = stderr.map((line) => {
		const parsed = JSON.parse(line);

		if (!Value.Check(PROGRESS, parsed)) throw new Error(`not a progress line: ${line}`);

		return parsed.progress;
	});

	return snapshots.at(-1) ?? [];
}

/** A connection to the host of `project` that runs in this process. */
async function connectTo(project: string) {
	const saved = process.env.HARNESS_PROJECT;
	process.env.HARNESS_PROJECT = project;

	try {
		const client = await connect({ start: false });

		if (client === undefined) throw new Error(`no host for ${project}`);

		return client;
	} finally {
		if (saved === undefined) delete process.env.HARNESS_PROJECT;
		else process.env.HARNESS_PROJECT = saved;
	}
}

/**
 * Runs `workflows <argv>` in `cwd` against a fresh fake model. The first connection starts a harness host in this
 * process with the fake model, and the host closes when the command ends, as a stopped host does, unless `keepHost`.
 * A later command then gets a new host, which resumes the pending runs. With `host`, the command connects to that host
 * and leaves it open. Ctrl+C works as in the real command: `ctrlC.press()` presses it, and so does an abort of
 * `interrupt`. A press that would make the real command exit is counted in `exits`.
 */
export async function workflows(
	argv: readonly string[],
	options: {
		readonly cwd: string;
		readonly stdin?: string;
		readonly script?: Omit<Script, "interrupt">;
		readonly interrupt?: AbortController;
		readonly ctrlC?: CtrlC;
		/** The window for a second Ctrl+C; default 0, so a detached command ends at once. */
		readonly stopWindowMs?: number;
		readonly host?: Host;
		readonly keepHost?: boolean;
		/** The first `start` request fails after the host created its task, as when the connection closes before the reply. */
		readonly dropStart?: boolean;
	},
): Promise<Outcome> {
	let exits = 0;

	const ctrlC =
		options.ctrlC ??
		new CtrlC(() => {
			exits++;
		});

	const { interrupt } = options;

	if (interrupt?.signal.aborted) ctrlC.press();
	else interrupt?.signal.addEventListener("abort", () => ctrlC.press(), { once: true });

	const model = new FakeModel({
		...options.script,
		interrupt: { signal: ctrlC.interrupt, abort: () => ctrlC.press() },
	});

	const stdout: string[] = [];
	const stderr: string[] = [];
	let host = options.host;
	let started: Host | undefined;
	let drop = options.dropStart === true;

	const code = await main(argv, {
		cwd: options.cwd,
		stdin: async () => options.stdin,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		interrupt: ctrlC.interrupt,
		stop: ctrlC.stop,
		following: (active) => ctrlC.following(active),
		stopWindowMs: options.stopWindowMs ?? 0,
		models: async () => model.models,
		connect: async (project, start) => {
			if (host === undefined) {
				if (!start) return undefined;
				started = await startHost(project, model.models);
				host = started;
			}

			const client = await connectTo(project);
			const request = client.request.bind(client);
			client.request = async <T extends Request["type"]>(sent: Extract<Request, { type: T }>): Promise<Replies[T]> => {
				const reply = await request(sent);

				if (sent.type !== "start" || !drop) return reply;
				drop = false;
				const closed = new Error("The harness host closed the connection");
				client.abort(closed);
				throw closed;
			};

			return client;
		},
	});

	if (!options.keepHost) await started?.close();
	const id = stdout.find((line) => line.startsWith("run "))?.slice(4);

	return { code, stdout, stderr, model, id, host: options.keepHost ? started : undefined, exits };
}

/** A harness host of `project` in this process, with `models`. */
export async function startHost(project = "main", models = createModels()): Promise<Host> {
	const host = await runHost({ stateDir: statePaths(project).dir, project, cwd: projectDir(project), models });

	if (host === undefined) throw new Error(`another host has the lock of ${project}`);

	return host;
}

/** Sends `request` to the host of `project` that runs in this process. */
async function send(request: Request, project = "main"): Promise<void> {
	const client = await connectTo(project);

	try {
		await client.request(request);
	} finally {
		client.close();
	}
}

/** Sends `message` to the project agent of the host of `project` that runs in this process. */
export function tellAgent(message: string, project = "main"): Promise<void> {
	return send({ type: "input", requestId: `test:${message}`, handle: AGENT_HANDLE, message, followUp: false }, project);
}

/** Presses Esc in the project agent of the host of `project` that runs in this process: it aborts its turn. */
export function escAgent(project = "main"): Promise<void> {
	return send({ type: "abort", handle: AGENT_HANDLE }, project);
}

/** A result of the `workflow` tool in a transcript: its text, its details, and whether it is an error. */
export type WorkflowResult = { readonly text: string; readonly details: unknown; readonly isError: boolean };

/** The entries in the transcripts of the store of `project`, in entry order of each conversation. */
async function entriesOf(project: string): Promise<EntryRecord[]> {
	const storage = await openNodeSqliteStorage(storeOf(project));

	try {
		const found: EntryRecord[] = [];
		const { items } = await storage.scanConversations({}, 256, undefined, BACKGROUND_CONTEXT);

		for (const { id } of items) {
			const query = { conversationId: id, order: "ascending" } as const;
			found.push(...(await storage.scanEntries(query, 1024, undefined, BACKGROUND_CONTEXT)).items);
		}

		return found;
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

/** The results of the `workflow` tool in the transcripts of the store of `project`, in entry order of each conversation. */
export async function workflowResults(project = "main"): Promise<WorkflowResult[]> {
	return (await entriesOf(project)).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			message.role === "toolResult" && message.toolName === "workflow"
				? [{ text: textOf(message), details: message.details, isError: message.isError }]
				: [],
		),
	);
}

/** A run outcome that a background run posted as a message: its text, its data, and the conversation it went to. */
export type PostedResult = { readonly text: string; readonly data: unknown; readonly conversation: number };

/** The `workflows.result` entries in the transcripts of the store of `project`. */
export async function postedResults(project = "main"): Promise<PostedResult[]> {
	return (await entriesOf(project)).flatMap((entry) =>
		entry.kind === "workflows.result"
			? [{ text: (entry.model ?? []).map(textOf).join("\n"), data: entry.data, conversation: entry.conversationId }]
			: [],
	);
}

/** Waits until the store of `project` has more than `count` results of the `workflow` tool, and gives the next one. */
export async function nextResult(count: number, project = "main"): Promise<WorkflowResult> {
	for (;;) {
		const results = await workflowResults(project);
		const next = results[count];

		if (next !== undefined) return next;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A model for a host that a test starts itself, with no Ctrl+C. */
export function hostModel(script: Omit<Script, "interrupt"> = {}): FakeModel {
	return new FakeModel({ ...script, interrupt: { signal: new AbortController().signal, abort: () => {} } });
}
