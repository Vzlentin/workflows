/**
 * An entry of the test hosts: it checks the label kind `item` and refuses `item:99`. It writes each report that it gets
 * as one JSON line `{ labels, refs }` to `reported.jsonl` next to harness's `entries.json`, and `reportedEvents` reads them.
 * It fails each report of a worker with the label `item:98`, and writes no line for it.
 */
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { entriesPath } from "@vzlentin/harness/entries";
import type { ReportedEvent } from "@vzlentin/harness/entry-api";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** A report that the entry got: the labels of the worker and the references of the report. */
const REPORTED = Type.Object({ labels: Type.Array(Type.String()), refs: Type.Array(Type.String()) });

/** The file of the reports that the entry got, one JSON line each. */
function reportedPath(): string {
	return join(dirname(entriesPath()), "reported.jsonl");
}

/** The text of the reports file, or no text when the entry got no report and so wrote no file. */
async function reportedText(): Promise<string> {
	try {
		return await readFile(reportedPath(), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

/** The reports that the entry got, in order. */
export async function reportedEvents() {
	return (await reportedText())
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => Value.Parse(REPORTED, JSON.parse(line)));
}

export default function labelsEntry() {
	return {
		extensions: [],
		labels: [
			{
				kind: "item",
				check: async (label: string) => {
					if (label === "item:99") throw new Error("The fixture refuses item:99");
				},
			},
		],
		reported: async ({ labels, refs }: ReportedEvent) => {
			if (labels.includes("item:98")) throw new Error("The fixture refuses the reports of item:98");
			await appendFile(reportedPath(), `${JSON.stringify({ labels, refs })}\n`);
		},
		close: async () => {},
	};
}
