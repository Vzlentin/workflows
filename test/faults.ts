/** Faults that a test puts on the requests of the command to its host, as when the connection closes at a bad time. */
import type { Client } from "@vzlentin/harness/client";
import type { Replies, Request } from "@vzlentin/harness/protocol";

/** The faults of the requests of one command. */
export type Faults = {
	/** The first `start` request fails after the host created its task, as when the connection closes before the reply. */
	readonly dropStart?: boolean;
	/**
	 * The first `start` request fails before the host gets it, and the host gets it after the next request of the
	 * command, as a start that arrives late.
	 */
	readonly lateStart?: boolean;
	/** After the reply to an `abort-task` request, every connection of the command closes, as when the host stops. */
	readonly dropAfterAbort?: boolean;
};

/** The state of the faults of one command, shared by all its connections. */
export type FaultState = {
	drop: boolean;
	late: boolean;
	held: Request | undefined;
	readonly clients: Client[];
};

/** The state of `faults` before the first request of a command. */
export function faultState(faults: Faults): FaultState {
	return { drop: faults.dropStart === true, late: faults.lateStart === true, held: undefined, clients: [] };
}

/** The error of harness's client when the host closes the connection. */
const closed = () => new Error("The harness host closed the connection");

/** Puts the faults of `faults` on the requests of `client`, a connection of the command whose fault state is `state`. */
export function addFaults(client: Client, faults: Faults, state: FaultState): void {
	state.clients.push(client);
	const request = client.request.bind(client);

	client.request = <T extends Request["type"]>(sent: Extract<Request, { type: T }>): Promise<Replies[T]> =>
		faultyRequest(client, request, sent, faults, state);
}

/** Sends `sent` with `request`, the request of `client` with no fault, and adds the faults of `faults`. */
async function faultyRequest<T extends Request["type"]>(
	client: Client,
	request: Client["request"],
	sent: Extract<Request, { type: T }>,
	faults: Faults,
	state: FaultState,
): Promise<Replies[T]> {
	if (sent.type === "start" && state.late) {
		state.late = false;
		state.held = sent;
		const error = closed();
		client.abort(error);
		throw error;
	}

	const reply = await request(sent);

	if (state.held !== undefined) {
		const start = state.held;
		state.held = undefined;
		await request(start);
	}

	if (sent.type === "abort-task" && faults.dropAfterAbort) {
		const error = closed();

		for (const each of state.clients) each.abort(error);

		return reply;
	}

	if (sent.type !== "start" || !state.drop) return reply;
	state.drop = false;
	const error = closed();
	client.abort(error);
	throw error;
}
