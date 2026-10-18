/**
 * The command's reads of a project store, which the harness host writes at the same time. The command opens the file
 * read-only: it takes no write lock, and its close runs no checkpoint, which would make the host wait.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Cursor, DocumentId, TaskRecord } from "@earendil-works/pi-durable";
import {
	type SqliteDatabase,
	type SqliteExecutor,
	SqliteStorage,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { isObject } from "./meta.ts";
import { PROGRESS_KIND, type ProgressEvent } from "./progress.ts";
import { CALL_KIND, type CallRecord } from "./script.ts";
import { TASK } from "./task.ts";

/** How long a read waits for the lock of the host's commit. */
const BUSY_TIMEOUT_MS = 60_000;

export type RunTask = TaskRecord<JsonValue, JsonValue, JsonValue>;

/**
 * pi-durable's SQLite facade on a read-only connection. Opening the storage inserts its schema row when it is missing,
 * which a store that a host opened has, so that write is skipped.
 */
class ReadOnlyDatabase implements SqliteDatabase {
	readonly #database: DatabaseSync;
	readonly #statements = new Map<string, StatementSync>();
	#transactions: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#database = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
	}

	#statement(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (statement === undefined) {
			statement = this.#database.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	async exec(sql: string): Promise<void> {
		this.#database.exec(sql);
	}

	async run(sql: string, ...params: SqliteValue[]): Promise<void> {
		try {
			this.#statement(sql).run(...params);
		} catch (error) {
			if (!sql.startsWith("INSERT OR IGNORE") || !String(error).includes("readonly")) throw error;
		}
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		return this.#statement(sql).get(...params) as T | undefined;
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		return this.#statement(sql).all(...params) as T[];
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		const result = this.#transactions.then(async () => {
			this.#database.exec("BEGIN");
			try {
				const value = await callback(this);
				this.#database.exec("COMMIT");
				return value;
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
		});
		this.#transactions = result.catch(() => undefined);
		return result;
	}

	async close(): Promise<void> {
		this.#statements.clear();
		this.#database.close();
	}
}

export type Store = SqliteStorage;

/**
 * The store at `path`, open for reads, or undefined when it does not exist. A store whose schema pi-durable must update
 * first cannot open read-only; the host of its project updates it when it starts.
 */
export async function openStore(path: string): Promise<Store | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		return await SqliteStorage.open(new ReadOnlyDatabase(path));
	} catch (error) {
		if (!String(error).includes("readonly")) throw error;
		const project = basename(dirname(path));
		throw new Error(
			`${path} needs a schema update that only its harness host makes: start the host once, such as with harness --project ${project} host, and run the command again`,
		);
	}
}

/** `read` on the store at `path`, open for reads; `fallback` when the store does not exist. */
export async function reading<T>(path: string, fallback: T, read: (store: Store) => Promise<T>): Promise<T> {
	const store = await openStore(path);
	if (store === undefined) return fallback;
	try {
		return await read(store);
	} finally {
		await store.close(BACKGROUND_CONTEXT);
	}
}

/** The run ID in the input of a workflow task, also of an earlier version, which some versions wrapped as `{ input }`. */
function runIdOf(input: JsonValue): string | undefined {
	const saved = isObject(input) && isObject(input.input) ? input.input : input;
	return isObject(saved) && typeof saved.runId === "string" ? saved.runId : undefined;
}

/**
 * The tasks of the kind `workflows.run` that no task owns, so not the tasks of child runs, by run ID, oldest first,
 * also of another version.
 */
export async function runTasks(store: Store): Promise<Map<string, RunTask[]>> {
	const runs = new Map<string, RunTask[]>();
	let cursor: Cursor | undefined;
	do {
		const page = await store.scanTasks({ kind: TASK.name }, 256, cursor, BACKGROUND_CONTEXT);
		for (const task of page.items) {
			const id = runIdOf(task.input);
			if (task.owner !== undefined || id === undefined) continue;
			runs.set(id, [...(runs.get(id) ?? []), task]);
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return runs;
}

/** The progress events of the root run `id`. */
export async function progressEvents(store: Store, id: string): Promise<readonly ProgressEvent[]> {
	const address = { kind: PROGRESS_KIND, scope: { kind: "session" as const }, key: id };
	const record = await store.findDocument(address, "current", BACKGROUND_CONTEXT);
	if (record === undefined) return [];
	const stored = await store.document(record.id, "current", BACKGROUND_CONTEXT);
	return (stored?.value as { events?: ProgressEvent[] } | undefined)?.events ?? [];
}

/**
 * The call records of the run `runId` and of its child runs, by key. The storage has no scan by key prefix, so it lists
 * the keys of every call record of the store, and reads only those of the run.
 */
export async function callRecords(store: Store, runId: string): Promise<Map<string, CallRecord>> {
	const documents = new Map<string, DocumentId>();
	let cursor: Cursor | undefined;
	do {
		const query = { scope: { kind: "session" as const }, at: "current" as const, kind: CALL_KIND };
		const page = await store.scanDocuments(query, 256, cursor, BACKGROUND_CONTEXT);
		for (const record of page.items) if (record.key !== undefined) documents.set(record.key, record.id);
		cursor = page.next;
	} while (cursor !== undefined);
	const records = new Map<string, CallRecord>();
	const runs = [runId];
	for (const run of runs) {
		for (const [key, id] of documents) {
			if (!key.startsWith(`${run}/`)) continue;
			const stored = await store.document(id, "current", BACKGROUND_CONTEXT);
			if (stored === undefined) continue;
			const record = stored.value as CallRecord;
			records.set(key, record);
			if (record.child !== undefined) runs.push(record.child.runId);
		}
	}
	return records;
}
