import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	AssistantMessage,
	Message,
	SimpleStreamOptions,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { REMINDER } from "harness/src/answer.ts";
import { connect } from "harness/src/client.ts";
import { type Host, runHost } from "harness/src/host.ts";
import { projectDir } from "harness/src/projects.ts";
import { statePaths } from "harness/src/protocol.ts";
import { main } from "../src/main.ts";
import { CtrlC } from "../src/run.ts";

/** The workflows checkout, which the hosts of the tests load as a local Pi package. */
export const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

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

type Input = { readonly runId: string; readonly root: string };

const stateOf = ({ state }: Awaited<ReturnType<typeof runTasks>>[number]) =>
	state.status === "terminal" ? { status: state.status, outcome: state.outcome.status } : { status: state.status };

/** The state of each task of the run `id` of `project` that no task owns. */
export async function rootTasks(id: string, project = "main") {
	return (await runTasks(project))
		.filter((task) => task.owner === undefined && (task.input as Input).runId === id)
		.map(stateOf);
}

/** The run ID and the state of each task of a child run of the run `id` of the `main` project. */
export async function childTasks(id: string) {
	return (await runTasks("main"))
		.filter((task) => task.owner !== undefined && (task.input as Input).root === id)
		.map((task) => ({ runId: (task.input as Input).runId, ...stateOf(task) }));
}

/** Writes Pi's settings of the sandbox `root`: the workflows checkout and `packages`, and `settings`. */
export async function piSettings(root: string, packages: readonly string[] = [], settings: object = {}): Promise<void> {
	await writeFile(
		join(root, "agent", "settings.json"),
		JSON.stringify({ retry: { enabled: false }, ...settings, packages: [PACKAGE, ...packages] }),
	);
}

/**
 * A fresh environment: home, state, configuration, Pi agent and Git configuration under a temporary directory, and a
 * fake `gh`. Pi's settings list the workflows checkout, so the test hosts load its entry.
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
	| "review"
	| "verdict"
	| "judge"
	| "split"
	| "requeue"
	| "reflect"
	| "script";

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
	["Plan this change.", "plan"],
	["Challenge the plan", "challenge"],
	["Write a handoff document", "handoff"],
	["Implement this plan", "implement"],
	["Perform a deep code quality audit", "review"],
	["## Vocabulary", "judge"],
	["Split this goal into work items.", "split"],
	["Update the work item queue", "requeue"],
	["Improve this prompt", "reflect"],
	["Script", "script"],
];

function textOf(message: Message): string {
	if (message.role === "system") return "";
	const { content } = message;
	if (typeof content === "string") return content;
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
	/** The work items of the split answer. */
	readonly items?: readonly string[];
	/** The queue of each requeue answer; a missing answer is an empty queue. */
	readonly queues?: readonly (readonly string[])[];
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

	readonly #respond = async (
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		_state: unknown,
		model: { readonly id: string; readonly provider: string },
	): Promise<AssistantMessage> => {
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
		const prompt = user === undefined ? "" : textOf(user);
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
			case "split":
				return respond({ items: [...(this.#script.items ?? [])] });
			case "requeue":
				return respond({ items: [...(this.#script.queues?.[nth - 1] ?? [])] });
			case "reflect": {
				// The reply keeps the current text first, so that the prompt keeps its kind.
				const current = /\n## current\n([\s\S]*?)\n\n## records\n/.exec(prompt)?.[1] ?? "";
				return fauxAssistantMessage(`${current}\nImproved prompt ${nth}.`);
			}
			case "script": {
				// `Script spawn: <prompt>` spawns a subagent with the prompt `Script: <prompt>` through harness's tool.
				const spawned = /^Script spawn: (.*)$/s.exec(prompt)?.[1];
				if (spawned !== undefined) {
					const spawn = fauxToolCall("subagent", { action: "spawn", prompts: [`Script: ${spawned}`] });
					return fauxAssistantMessage(spawn, { stopReason: "toolUse" });
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
		return typeof judge === "string" ? fauxAssistantMessage(judge) : respond(judge as Verdict);
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

/** The lines of the last `{"progress":[...]}` stderr line of a `--json` run, and throws for any other stderr line. */
export function progressOf(stderr: readonly string[]): string[] {
	const snapshots = stderr.map((line) => (JSON.parse(line) as { progress: string[] }).progress);
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
			client.request = (async (sent: Parameters<typeof request>[0]) => {
				const reply = await request(sent);
				if (sent.type !== "start" || !drop) return reply;
				drop = false;
				const closed = new Error("The harness host closed the connection");
				client.abort(closed);
				throw closed;
			}) as typeof client.request;
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
