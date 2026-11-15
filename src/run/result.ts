/** The title of a run, and the status, report lines and exit code of its result. */
import type { JsonValue } from "@earendil-works/chord/json";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { subject } from "../launch/input.ts";
import { JSON_VALUE, type RunResult, waits } from "../tool.ts";
import type { ProgressEvent } from "./progress.ts";

/**
 * The fields of a saved input that the title, the report and the JSON of `show` read. A run that another version saved
 * has a title and a report only when its saved input has these fields.
 */
export const SHOWN_INPUT = Type.Object({
	runId: Type.String(),
	name: Type.String(),
	args: Type.Record(Type.String(), Type.Unknown()),
	meta: Type.Object({
		args: Type.Record(Type.String(), Type.Object({ type: Type.String() })),
		exit: Type.Record(Type.String(), Type.Integer()),
	}),
});

export type ShownInput = Static<typeof SHOWN_INPUT>;

/** The first `text` argument of `input`, whose subject is the run's title. */
function textArg(input: ShownInput): string | undefined {
	const [arg] = Object.entries(input.meta.args).find(([, spec]) => spec.type === "text") ?? [];
	const value = arg === undefined ? undefined : input.args[arg];

	return Value.Check(Type.String(), value) ? value : undefined;
}

/**
 * A result object of a script: the fields that the engine reads, each optional, and other fields of the script. The
 * engine writes `runId`, `branch` and `question`.
 */
export const RESULT_OBJECT = Type.Object(
	{
		status: Type.Optional(Type.String()),
		report: Type.Optional(Type.Array(Type.String())),
		subject: Type.Optional(Type.String()),
		score: Type.Optional(Type.Number()),
		runId: Type.Optional(Type.String()),
		branch: Type.Optional(Type.String()),
		question: Type.Optional(Type.String()),
	},
	{ additionalProperties: JSON_VALUE },
);

/** The result of a script: a result object, or a JSON value that is not an object. */
export const RESULT = Type.Union([
	RESULT_OBJECT,
	Type.Null(),
	Type.Boolean(),
	Type.Number(),
	Type.String(),
	Type.Array(JSON_VALUE),
]);

/** The status of a result object, if it has one. */
export function statusOf(result: JsonValue): string | undefined {
	return Value.Check(RESULT_OBJECT, result) ? result.status : undefined;
}

/**
 * A short name of the run's subject for output lines: the last `title` of the run in its progress `events`, else the
 * subject of its first text argument, or the script name.
 */
export function title(input: ShownInput, events: readonly ProgressEvent[]): string {
	const given = events.findLast((event) => event.kind === "title" && event.run === input.runId);

	if (given?.kind === "title") return given.text;
	const text = textArg(input);

	return text === undefined ? input.name : subject(text);
}

/**
 * The lines that a run with a result prints, the status of the result, if any, the exit code of the command, and the
 * judge score of the result, if any.
 */
export type Report = {
	readonly lines: string[];
	readonly status: string | undefined;
	readonly code: number;
	readonly score: number | undefined;
};

/**
 * The report lines of the result of the run `input`, its status, its score, and the exit code of its status as
 * `meta.exit` gives it: 3 for a result that waits for an answer, whatever `meta.exit` says, 0 for a result without a
 * status, and 1 for a status that `meta.exit` does not declare.
 */
export function reportOf(input: ShownInput, result: JsonValue): Report {
	const object = Value.Check(RESULT_OBJECT, result) ? result : undefined;
	const lines = object?.report ?? [Value.Check(Type.String(), result) ? result : JSON.stringify(result)];
	const score = object?.score;

	if (waits(result)) return { lines, status: result.status, code: 3, score };
	const status = statusOf(result);

	if (status === undefined) return { lines, status, code: 0, score };
	const code = Object.hasOwn(input.meta.exit, status) ? (input.meta.exit[status] ?? 1) : 1;

	return { lines, status, code, score };
}

/** The result of a run as its JSON gives it: the status of `report`, if any, its exit code, and its judge score, if any. */
export function runResult({ status, code, score }: Report): RunResult {
	const result: RunResult = status === undefined ? { code } : { status, code };

	if (score !== undefined) result.score = score;

	return result;
}

/**
 * The branch of a run: the `branch` of the value `value` of its result, the branch that its worktree ends on, else the
 * branch of its worktree `worktree`. Undefined for a run without either.
 */
export function runBranch(
	value: JsonValue | undefined,
	worktree: { readonly branch: string } | undefined,
): string | undefined {
	return (Value.Check(RESULT_OBJECT, value) ? value.branch : undefined) ?? worktree?.branch;
}
