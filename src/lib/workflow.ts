/**
 * A workflow is a durable task of phases. Each phase gets a `Step`: the saved input, its checkpoint, sessions, and
 * the commit that moves the run on. A phase may run again after an interruption or a failure, so it must reach the
 * same result when repeated: answered turns are not sent again, and Git steps must be safe to repeat.
 *
 * A phase that throws fails the run and keeps its checkpoint. A resume starts a new task from that checkpoint, which
 * runs the failed phase again and sends a failed turn again under a new request ID.
 */
import type { Context, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationHandle,
	type ConversationId,
	configure,
	defineTask,
	type Extension,
	type NextTaskState,
	type RunningTask,
	type Task,
	type TaskRuntime,
	type Tx,
} from "@earendil-works/pi-durable";
import { type AgentChoice, sessionAgent } from "./agents.ts";

/** Bad command-line usage: the command prints its usage and exits 2. */
export class UsageError extends Error {}

export type Checkpoint = { readonly phase: string };

/** A checkpoint with a session that a phase opens on its first run. */
export type SessionCheckpoint = Checkpoint & { readonly conversation?: ConversationId };

/** One conversation with a fixed agent. */
export type Session = {
	/** The answer to `content`. A turn answered before returns its saved answer without a model call. */
	say(requestId: string, content: string): Promise<string>;
};

export type Step<I, C extends Checkpoint, S extends Checkpoint, R> = {
	readonly input: I;
	readonly checkpoint: C;
	/** Writes one progress line. */
	log(line: string): void;
	/** Commits the next checkpoint. */
	advance(next: S): Promise<void>;
	/** Commits the result; the run is over. */
	finish(result: R): Promise<void>;
	/**
	 * The phase's session, kept in `checkpoint.conversation`. On the phase's first run this opens the session, commits
	 * it, and returns undefined: the phase then returns and runs again with the session. `setup` runs in the same commit,
	 * after the session's agent is configured.
	 */
	session(
		choice: AgentChoice,
		cwd: string,
		setup?: (tx: Tx, conversation: ConversationId) => Promise<void>,
	): Promise<Session | undefined>;
};

type Phases<I, S extends Checkpoint, R> = {
	readonly [P in S["phase"]]: (step: Step<I, Extract<S, { phase: P }>, S, R>) => Promise<void>;
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

/** What the extensions of a workflow get from the command. */
export type ExtensionHost = {
	/** Writes one progress line. */
	log(line: string): void;
	/** Stops the command with `message` as a resumable failure; the run's task stays pending. */
	fail(message: string): void;
};

export type Workflow<A, I, S extends Checkpoint, R> = {
	/** The command name: `workflows <name>`. */
	readonly name: string;
	readonly usage: string;
	/** The checked arguments; throws `UsageError` or `Error` before a run directory exists. */
	parse(args: readonly string[], io: Io): Promise<A>;
	/** The input saved before execution starts; may write into the new run directory. */
	prepare(args: A, run: Run): Promise<I>;
	/** A short name of the run's subject for output lines. */
	title(input: I): string;
	initial(input: I): S;
	readonly phases: Phases<I, S, R>;
	/** Prints the result and returns the exit code. */
	report(input: I, result: R, io: Io): number;
	/** Extensions that the store installs for every run. Sessions select them only by name. */
	extensions?(host: ExtensionHost): readonly Extension[];
	/** Model providers that runs of this workflow use. */
	readonly providers?: readonly Provider[];
};

/** Identity function that types a workflow. */
export function defineWorkflow<A, I, S extends Checkpoint, R>(workflow: Workflow<A, I, S, R>): Workflow<A, I, S, R> {
	return workflow;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds workflows of any argument, input and result types.
export type AnyWorkflow = Workflow<any, any, any, any>;

/** The stored task input: the workflow input, and the checkpoint a resume continues from after a failure. */
export type Stored = { readonly input: JsonValue; readonly from?: Checkpoint };

export const taskKind = (workflow: AnyWorkflow): string => `workflows.${workflow.name}`;

type Runtime = TaskRuntime<Stored, Checkpoint, JsonValue, object>;

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

function stepOf(
	stored: Stored,
	checkpoint: SessionCheckpoint,
	runtime: Runtime,
	context: Context,
	log: (line: string) => void,
): Step<unknown, Checkpoint, Checkpoint, unknown> {
	const commit = (next: NextTaskState<Checkpoint, JsonValue>) => runtime.commit(() => next, context);
	return {
		input: stored.input,
		checkpoint,
		log,
		advance: (next) => commit({ status: "running", checkpoint: next }),
		finish: (result) => commit({ status: "terminal", outcome: { status: "completed", result: result as JsonValue } }),
		session: async (choice, cwd, setup) => {
			if (checkpoint.conversation !== undefined) return sessionOf(runtime, checkpoint.conversation, context);
			await runtime.commit(async (tx) => {
				const created = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
				await configure(tx, created.id, sessionAgent(choice, cwd));
				await setup?.(tx, created.id);
				return { status: "running", checkpoint: { ...checkpoint, conversation: created.id } };
			}, context);
			return undefined;
		},
	};
}

/** The durable task of `workflow`; `log` receives its progress lines. */
export function workflowTask(
	workflow: AnyWorkflow,
	log: (line: string) => void,
): Task<Stored, Checkpoint, JsonValue, object> {
	const handlers = workflow.phases as Record<
		string,
		(step: Step<unknown, Checkpoint, Checkpoint, unknown>) => Promise<void>
	>;
	const run = async (task: RunningTask<Stored, Checkpoint, JsonValue>, runtime: Runtime, context: Context) => {
		const { checkpoint } = task.state;
		const handler = handlers[checkpoint.phase];
		try {
			if (handler === undefined) throw new Error(`${workflow.name} has no phase ${checkpoint.phase}`);
			await handler(stepOf(task.input, checkpoint, runtime, context, log));
		} catch (error) {
			// A closing store cancels the phase; it runs again when the run resumes.
			if (runtime.signal.aborted) throw error;
			const message = error instanceof Error ? error.message : String(error);
			await runtime.commit(
				(_tx, current) => ({
					status: "terminal",
					outcome: { status: "failed", error: { message, detail: { from: current.state.checkpoint } } },
				}),
				context,
			);
		}
	};
	return defineTask<Stored, Checkpoint, JsonValue>({
		name: taskKind(workflow),
		version: 2,
		// Older inputs only have fields that this version does not read.
		migrate: (input, checkpoint) => ({ input: input as Stored, checkpoint: checkpoint as Checkpoint }),
		initial: (stored) => stored.from ?? workflow.initial(stored.input),
		phases: Object.fromEntries(Object.keys(handlers).map((phase) => [phase, run])),
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});
}
