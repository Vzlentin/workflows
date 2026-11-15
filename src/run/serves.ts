/**
 * What a run serves: the todo of the list of the project or the parley that its start named, which the host of its
 * project keeps. A root task checks it when it starts, through the requests of harness to that host.
 */
import { request } from "@vzlentin/harness/client";
import { isFinished, type ServesInput, Todo } from "@vzlentin/harness/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { askerOf } from "./asks.ts";

const TODOS = Type.Object({ todos: Type.Array(Todo) });

const PARLEY = Type.Object({ parley: Type.Object({ slug: Type.String(), status: Type.String() }) });

/** `reply`, the reply of the host of `project`, which is undefined when no host runs. */
function hostReply<T>(project: string, reply: T | undefined): T {
	if (reply === undefined) throw new Error(`no harness host runs for ${project}`);

	return reply;
}

/** The error of a reply to the request `name` that does not have the expected shape. */
function badReply(name: string): Error {
	return new Error(`the harness host gave a bad reply to ${name}`);
}

/**
 * Checks that the run `runId` of `project` can serve `serves`, as harness checks what an agent serves: a parley that is
 * open or a contract, or a todo of the list of the project that is not done or dropped. It throws for any other, and
 * for a parley or a todo that the host does not know.
 */
export async function checkServes(
	project: string,
	runId: string,
	serves: ServesInput,
	signal: AbortSignal | undefined,
): Promise<void> {
	const options = { project, start: false, signal };

	if ("parley" in serves) {
		const reply = hostReply(project, await request({ type: "parley", action: "read", slug: serves.parley }, options));

		if (!Value.Check(PARLEY, reply)) throw badReply("parley read");
		const { parley } = reply;

		if (parley.status !== "open" && parley.status !== "contract") {
			throw new Error(`Parley ${parley.slug} is ${parley.status}: a run cannot serve it`);
		}

		return;
	}

	const sent = { type: "todo", action: "list", caller: askerOf(runId), handle: "agent" } as const;
	const reply = hostReply(project, await request(sent, options));

	if (!Value.Check(TODOS, reply)) throw badReply("todo list");
	const todo = reply.todos.find(({ id }) => id === serves.todo);

	if (todo === undefined) throw new Error(`Unknown todo: ${serves.todo}`);

	if (isFinished(todo.state)) throw new Error(`Todo ${todo.id} is ${todo.state}: a run cannot serve it`);
}
