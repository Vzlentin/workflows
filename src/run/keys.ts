/**
 * The store keys of the calls of a run, `<run ID>/<call key>`, and the names of its steps, `s<n>` in the root run and
 * `<run ID>/s<n>` in a child run.
 */

/** The prefix of the store keys of the calls of the run `runId`. */
export function callPrefix(runId: string): string {
	return `${runId}/`;
}

/** The store key of the call `own` of the run `runId`. */
export function keyIn(runId: string, own: string): string {
	return `${callPrefix(runId)}${own}`;
}

/** Whether the store key `key` is a call of the run `runId`, and not of one of its child runs. */
export function ownedBy(runId: string, key: string): boolean {
	return key.startsWith(callPrefix(runId));
}

/** The name of the call `key` in the run `root`: the key without `<root>/`, or the whole key for a child run. */
export function nameOfKey(root: string, key: string): string {
	return ownedBy(root, key) ? key.slice(callPrefix(root).length) : key;
}

/** The store key of the call named `name` in the run `root`. */
export function keyOfName(root: string, name: string): string {
	return name.includes("/") ? name : keyIn(root, name);
}

/** The name of a step: `s<n>` in the root run, `<run>/s<n>` in a child run. */
const STEP_NAME = /^(?:(.+)\/)?s(\d+)$/;

/** A step: its run, and its number as text. */
export type StepRef = { runId: string; n: string };

/** The name of the step `n` of the run `runId` in the root run `root`. */
export function stepName(root: string, runId: string, n: number): string {
	return runId === root ? `s${n}` : keyIn(runId, `s${n}`);
}

/**
 * The step named `name` in the root run `root`, or undefined when `name` names a call: a call name always ends in
 * `.<n>`, its counter, so it never ends in `s<digits>`.
 */
export function stepOf(root: string, name: string): StepRef | undefined {
	const [, child, n] = STEP_NAME.exec(name) ?? [];

	return n === undefined ? undefined : { runId: child ?? root, n };
}
