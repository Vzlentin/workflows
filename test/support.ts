import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { main } from "../src/lib/main.ts";
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

export type Kind = "plan" | "challenge" | "handoff" | "implement" | "review" | "verdict" | "judge";

/** One answered prompt: its kind, model, thinking level, offered tools, system prompt sections, and text. */
export type Call = {
	readonly kind: Kind;
	readonly model: string;
	readonly thinking: string | undefined;
	readonly tools: readonly string[];
	readonly sections: Readonly<Record<string, string | null>>;
	readonly prompt: string;
};

const KINDS: readonly (readonly [string, Kind])[] = [
	["Plan this change.", "plan"],
	["Challenge the plan", "challenge"],
	["Write a handoff document", "handoff"],
	["Implement this plan", "implement"],
	["Perform a deep code quality audit", "review"],
	["## Vocabulary", "judge"],
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
	readonly judge?: string;
	/** The prompt that interrupts the run: Ctrl+C is pressed while it waits for its answer. */
	readonly interruptAt?: { readonly kind: Kind; readonly nth: number };
	/** The prompt that the provider answers with an error. */
	readonly failAt?: { readonly kind: Kind; readonly nth: number };
	/** Pressed Ctrl+C. */
	readonly interrupt: AbortController;
};

export const PASSING_JUDGE = [
	"Everything holds up.",
	"1 PASS",
	"2 PASS",
	"3 PASS",
	"4 FAIL README.md:3 adds a line the work item does not need",
	"5 PASS",
	"6 PASS",
	"7 PASS",
	"8 PASS",
].join("\n");

/**
 * A scripted model for the `anthropic` provider. It records every prompt it answers. After Ctrl+C it answers
 * nothing: a request waits until the run closes.
 */
export class FakeModel {
	readonly calls: Call[] = [];
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
		const last = messages.findLast((message) => message.role !== "system");
		if (last?.role === "toolResult") return fauxAssistantMessage("I fixed the typo in README.md.");
		const prompt = last === undefined ? "" : textOf(last);
		const found = KINDS.find(([start]) => prompt.startsWith(start))?.[1];
		if (found === undefined) throw new Error(`unexpected prompt: ${prompt}`);
		const kind = found === "challenge" && prompt.includes("End with one line: SHIP") ? "verdict" : found;
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
		const system = messages.flatMap((message) => (message.role === "system" ? [message] : []));
		this.calls.push({
			kind,
			model: model.id,
			thinking: options?.reasoning,
			tools: system.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name)),
			sections: Object.assign({}, ...system.map((message) => message.sections ?? {})),
			prompt,
		});
		switch (kind) {
			case "plan":
				return fauxAssistantMessage("Problem: README.md says wrold.");
			case "challenge":
				return fauxAssistantMessage("Keep: one word changes.");
			case "handoff":
				return fauxAssistantMessage(`Handoff ${this.count("handoff")}: replace wrold with world in README.md.`);
			case "implement": {
				const edit = this.#script.edits?.[nth - 1];
				if (edit === undefined) return fauxAssistantMessage("I found nothing to change.");
				const call = this.#script.commits
					? fauxToolCall("bash", {
							command: `printf '%s' '${edit}' > README.md && git commit -qam 'implementer ${nth}'`,
						})
					: fauxToolCall("write", { path: "README.md", content: edit });
				return fauxAssistantMessage(call, { stopReason: "toolUse" });
			}
			case "review":
				return fauxAssistantMessage(`Review ${nth}: the change is small.`);
			case "verdict":
				return fauxAssistantMessage(`Nothing else.\n\n**${this.#script.verdicts?.[nth - 1] ?? "SHIP"}**`);
			case "judge":
				return fauxAssistantMessage(this.#script.judge ?? PASSING_JUDGE);
		}
	};
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
			interrupt: interrupt.signal,
		},
		[ship],
	);
	const id = stdout.find((line) => line.startsWith("run "))?.slice(4);
	return { code, stdout, stderr, model, id };
}
