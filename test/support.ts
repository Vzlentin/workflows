import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AssistantMessage,
	Message,
	SimpleStreamOptions,
	ToolCall,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { main } from "../src/lib/main.ts";
import type { AnyWorkflow } from "../src/lib/workflow.ts";
import { campaign } from "../src/workflows/campaign.ts";
import { run } from "../src/workflows/run.ts";
import { ship } from "../src/workflows/ship.ts";

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
}

const ENVIRONMENT = { ...process.env };

/** A fresh environment: state, Pi agent and Git configuration under a temporary directory, and a fake `gh`. */
export async function sandbox(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "workflow2-test-"));
	const bin = join(root, "bin");
	await mkdir(bin);
	await mkdir(join(root, "agent"));
	await writeFile(join(root, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
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
		XDG_STATE_HOME: join(root, "state"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.com",
		PATH: `${bin}:${ENVIRONMENT.PATH}`,
	};
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
	| "script";

/** One answered prompt: its kind, model, thinking level, offered tools, system prompt sections, and text. */
export type Call = {
	readonly kind: Kind;
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
	/** The judge's `respond` answer, or a text reply without `respond`. */
	readonly judge?: Verdict | string;
	/** The work items of the split answer. */
	readonly items?: readonly string[];
	/** The queue of each requeue answer; a missing answer is an empty queue. */
	readonly queues?: readonly (readonly string[])[];
	/** The prompt that interrupts the run: Ctrl+C is pressed while it waits for its answer. */
	readonly interruptAt?: { readonly kind: Kind; readonly nth: number };
	/** The prompt that the provider answers with an error. */
	readonly failAt?: { readonly kind: Kind; readonly nth: number };
	/** The plan prompt first calls `probe` and `ls`, review and judge call `probe`, and implement calls `probe` next to its edit. */
	readonly probe?: boolean;
	/** Pressed Ctrl+C. */
	readonly interrupt: AbortController;
};

export type Verdict = { readonly answers: readonly ("PASS" | "FAIL")[]; readonly findings: readonly string[] };

export const PASSING_JUDGE: Verdict = {
	answers: ["PASS", "PASS", "PASS", "FAIL", "PASS", "PASS", "PASS", "PASS"],
	findings: ["4 FAIL README.md:3 adds a line the work item does not need"],
};

/**
 * A scripted model for the `anthropic` provider. It records every prompt it answers. After Ctrl+C it answers
 * nothing: a request waits until the run closes.
 */
export class FakeModel {
	readonly calls: Call[] = [];
	/** The text of every tool result the model received. */
	readonly results: string[] = [];
	readonly models = createModels();
	readonly #script: Script;

	constructor(script: Script) {
		this.#script = script;
		const faux = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-opus-5-5", reasoning: true }],
		});
		faux.setResponses(Array.from({ length: 200 }, () => this.#respond));
		this.models.setProvider(faux.provider);
	}

	count(kind: Kind): number {
		return this.calls.filter((call) => call.kind === kind).length;
	}

	readonly #respond = async (
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		_state: unknown,
		model: { readonly id: string },
	): Promise<AssistantMessage> => {
		const messages = context.messages;
		const system = messages.flatMap((message) => (message.role === "system" ? [message] : []));
		const tools: string[] = [];
		for (const message of system) {
			const removed = new Set((message.toolsRemoved ?? []).map((tool) => tool.name));
			tools.splice(0, tools.length, ...tools.filter((name) => !removed.has(name)));
			tools.push(...(message.toolsAdded ?? []).map((tool) => tool.name));
		}
		const user = messages.findLast((message) => message.role === "user");
		const prompt = user === undefined ? "" : textOf(user);
		const found = KINDS.find(([start]) => prompt.replace(MEMORY, "").startsWith(start))?.[1];
		if (found === undefined) throw new Error(`unexpected prompt: ${prompt}`);
		const kind = found === "challenge" && tools.includes("respond") ? "verdict" : found;
		const last = messages.findLast((message) => message.role !== "system");
		if (last?.role === "toolResult") {
			const after = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1);
			for (const message of after) if (message.role === "toolResult") this.results.push(textOf(message));
			if (kind === "judge") return this.#judge();
			if (kind === "implement") return implemented(this.count(kind), "I fixed the typo in README.md.");
			return fauxAssistantMessage("I fixed the typo in README.md.");
		}
		const nth = this.count(kind) + 1;
		const { interruptAt, interrupt } = this.#script;
		if (interruptAt?.kind === kind && interruptAt.nth === nth) interrupt.abort();
		if (interrupt.signal.aborted) {
			await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		}
		const { failAt } = this.#script;
		if (failAt?.kind === kind && failAt.nth === nth) {
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
		}
		this.calls.push({
			kind,
			model: model.id,
			thinking: options?.reasoning,
			tools,
			sections: Object.assign({}, ...system.map((message) => message.sections ?? {})),
			prompt,
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
					handoff: `Handoff ${nth}: replace wrold with world in README.md.`,
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
			case "script": {
				// `Script respond: <json>` answers with `respond`, any other `Script: <text>` with `Reply to <text>`.
				const answer = /^Script respond: (.*)$/s.exec(prompt)?.[1];
				if (answer === undefined) return fauxAssistantMessage(`Reply to ${prompt.slice("Script: ".length)}`);
				return respond(JSON.parse(answer));
			}
		}
	};

	#judge(): AssistantMessage {
		const { judge = PASSING_JUDGE } = this.#script;
		return typeof judge === "string" ? fauxAssistantMessage(judge) : respond(judge);
	}
}

function respond(answer: ToolCall["arguments"][string]): AssistantMessage {
	return fauxAssistantMessage(fauxToolCall("respond", { answer }), { stopReason: "toolUse" });
}

/** The `respond` answer of the nth implement turn. */
function implemented(nth: number, reply: string): AssistantMessage {
	return respond({ reply, notes: [`Implement ${nth}: README.md had wrold.`] });
}

export type Outcome = {
	readonly code: number;
	readonly stdout: readonly string[];
	readonly stderr: readonly string[];
	readonly model: FakeModel;
	readonly id: string | undefined;
};

/** Runs `workflows <argv>` in `cwd` against a fresh fake model. */
export async function workflows(
	argv: readonly string[],
	options: {
		readonly cwd: string;
		readonly stdin?: string;
		readonly script?: Omit<Script, "interrupt">;
		readonly interrupt?: AbortController;
		/** The installed workflows; `ship`, `campaign` and `run` by default. */
		readonly installed?: readonly AnyWorkflow[];
	},
): Promise<Outcome> {
	const interrupt = options.interrupt ?? new AbortController();
	const model = new FakeModel({ ...options.script, interrupt });
	const stdout: string[] = [];
	const stderr: string[] = [];
	const code = await main(
		argv,
		{
			cwd: options.cwd,
			stdin: async () => options.stdin,
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
			models: model.models,
			addProvider: (provider) => model.models.setProvider(provider),
			interrupt: interrupt.signal,
		},
		options.installed ?? [ship, campaign, run],
	);
	const id = stdout.find((line) => line.startsWith("run "))?.slice(4);
	return { code, stdout, stderr, model, id };
}
