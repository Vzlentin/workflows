/** The title of a run, and the status, report lines and exit code of its result. */
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type ScriptInput, subject } from "../launch/input.ts";
import type { ProgressEvent } from "./progress.ts";

/** The first `text` argument of `input`, whose subject is the run's title. */
function textArg(input: ScriptInput): string | undefined {
	const [arg] = Object.entries(input.meta.args).find(([, spec]) => spec.type === "text") ?? [];
	const value = arg === undefined ? undefined : input.args[arg];

	return Value.Check(Type.String(), value) ? value : undefined;
}

const STATUS = Type.Object({ status: Type.String() });
const REPORT = Type.Object({ report: Type.Array(Type.Unknown()) });

/** The status of a result object, if it has one. */
export function statusOf(result: JsonValue): string | undefined {
	return Value.Check(STATUS, result) ? result.status : undefined;
}

/**
 * A short name of the run's subject for output lines: the last `title` of the run in its progress `events`, else the
 * subject of its first text argument, or the script name.
 */
export function title(input: ScriptInput, events: readonly ProgressEvent[]): string {
	const given = events.findLast((event) => event.kind === "title" && event.run === input.runId);

	if (given?.kind === "title") return given.text;
	const text = textArg(input);

	return text === undefined ? input.name : subject(text);
}

/** The lines that a finished run prints, and the exit code of the command. */
export type Report = { readonly lines: string[]; readonly code: number };

/**
 * The report lines of the result of the run `input`, and the exit code of its status: 3 for `waiting`, whatever
 * `meta.exit` says.
 */
export function reportOf(input: ScriptInput, result: JsonValue): Report {
	const lines = Value.Check(REPORT, result)
		? result.report.map((line) => String(line))
		: [Value.Check(Type.String(), result) ? result : JSON.stringify(result)];

	const status = statusOf(result);

	if (status === "waiting") return { lines, code: 3 };
	const code = status !== undefined && Object.hasOwn(input.meta.exit, status) ? (input.meta.exit[status] ?? 0) : 0;

	return { lines, code };
}
