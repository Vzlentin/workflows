/**
 * The engine types that a run shares: the run ID, the command-line input, the stored task input and checkpoint, and
 * sessions. The script task is `scriptTask` in `meta.ts`.
 */
import { randomBytes } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantEntry, type ConversationHandle, type ConversationId, type Tx } from "@earendil-works/pi-durable";

/** A run ID, `<UTC timestamp>-<8 hex>`, so a sort by name is a sort by start time. */
export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	return `${stamp}-${randomBytes(4).toString("hex")}`;
}

/** Bad command-line usage: the command prints `usage`, or its own usage, and exits 2. */
export class UsageError extends Error {
	readonly usage: string | undefined;

	constructor(message: string, usage?: string) {
		super(message);
		this.usage = usage;
	}
}

/** The checkpoint of a run: its one phase. The saved calls of its script are memos of the task. */
export type Checkpoint = { readonly phase: "run" };

/** One conversation with a fixed agent. */
export type Session = {
	/** The answer to `content`. A turn answered before returns its saved answer without a model call. */
	say(requestId: string, content: string): Promise<string>;
};

/** What a run needs from the command line before it starts. */
export type Run = { readonly id: string; readonly directory: string; readonly cwd: string };

export type Io = {
	readonly cwd: string;
	/** The piped stdin, or undefined when stdin is a terminal. */
	readonly stdin: () => Promise<string | undefined>;
	readonly stdout: (line: string) => void;
	readonly stderr: (line: string) => void;
};

/** The stored task input: the workflow input. */
export type Stored = { readonly input: JsonValue };

/** What turns need from a task runtime or a tool API. */
export type Turns = {
	conversation(id: ConversationId, context: Context): Promise<ConversationHandle | undefined>;
	commit(change: (tx: Tx) => Promise<undefined>, context: Context): Promise<unknown>;
};

export function textOf(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** A session whose `turn` also gives the whole answer message. */
export function sessionOf(
	runtime: Turns,
	conversation: ConversationId,
	context: Context,
): Session & { turn(requestId: string, content: string): Promise<AssistantMessage> } {
	const turn = async (requestId: string, content: string) => {
		const handle = await runtime.conversation(conversation, context);
		if (handle === undefined) throw new Error(`Session ${conversation} is missing`);
		// A turn that failed before is sent again under the next free request ID.
		let attempt = requestId;
		await runtime.commit(async (tx) => {
			for (let n = 2; (await tx.submissionByRequest(conversation, attempt))?.status === "unanswered"; n++) {
				attempt = `${requestId}#${n}`;
			}
			return undefined;
		}, context);
		const submission = await handle.submit({ type: "input", content, requestId: attempt }, context);
		const settled = await submission.wait(context);
		if (settled.type !== "input" || settled.status !== "done") {
			const detail = settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`;
			throw new Error(`The ${requestId} turn was not answered: ${settled.reason ?? settled.status}${detail}`);
		}
		let answer: AssistantMessage | undefined;
		await runtime.commit(async (tx) => {
			answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
			return undefined;
		}, context);
		if (answer === undefined) throw new Error(`The ${requestId} answer ${settled.answer} is missing`);
		return answer;
	};
	return { turn, say: async (requestId, content) => textOf(await turn(requestId, content)).trim() };
}
