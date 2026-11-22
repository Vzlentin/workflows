/**
 * The command's reads of a host store, which the harness host writes at the same time. The command opens the file
 * read-only: it takes no write lock, and its close runs no checkpoint, which would make the host wait.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
	DocumentId,
	DocumentReader,
	JsonObject,
	SessionDocFamilyToken,
	SessionDocToken,
	TaskId,
} from "@earendil-works/pi-durable";
import {
	type SqliteDatabase,
	type SqliteExecutor,
	SqliteStorage,
	type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { StartedTasks } from "@vzlentin/harness/tasks";
import { readTodos, TASK_TODO_LIST_KIND, type Todo } from "@vzlentin/harness/todo";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ScriptInput } from "../launch/input.ts";
import { CALL_KIND, CALL_RECORD, childOf, type SavedCall } from "../run/calls.ts";
import { callPrefix } from "../run/keys.ts";
import { allPages, isOfRun, type RunTask, rootRuns, runIdOf, runStatus } from "../run/past.ts";
import { PROGRESS_EVENT, PROGRESS_KIND, type ProgressEvent } from "../run/progress.ts";
import { TASK } from "../run/version.ts";
import { type Progress, progressOf } from "./steps.ts";

// Node warns once that `node:sqlite` is experimental, as the module loads. The warning tells a user of the command
// nothing, so the load mutes warnings, and only for its own duration. This works only while this module is the first
// of the command to load `node:sqlite`.
// oxlint-disable-next-line typescript/unbound-method -- the load puts this same function back on `process`.
const emitWarning = process.emitWarning;

process.emitWarning = () => {};

const sqlite = process.getBuiltinModule("node:sqlite");

process.emitWarning = emitWarning;

const DOCUMENT_ROW = Type.Object({ id: Type.Number(), key_value: Type.String() });

/** How long a read waits for the lock of the host's commit. */
const BUSY_TIMEOUT_MS = 60_000;

/**
 * pi-durable's SQLite facade on a read-only connection. Opening the storage inserts its schema row when it is missing,
 * which a store that a host opened has, so that write is skipped.
 */
class ReadOnlyDatabase implements SqliteDatabase {
	readonly #database: DatabaseSync;
	readonly #statements = new Map<string, StatementSync>();
	#transactions: Promise<unknown> = Promise.resolve();
	// True while `snapshot` runs its read.
	#inSnapshot = false;

	constructor(path: string) {
		this.#database = new sqlite.DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
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

	/** A write, which the read-only connection refuses. */
	async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
		return Number(this.#statement(sql).run(...params).changes);
	}

	async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
		// SAFETY: SqliteStorage gives `T` as the row type of the columns that its own `sql` selects.
		return this.#statement(sql).get(...params) as T | undefined;
	}

	async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
		// SAFETY: SqliteStorage gives `T` as the row type of the columns that its own `sql` selects.
		return this.#statement(sql).all(...params) as T[];
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		// A transaction inside `snapshot` joins it: a nested `BEGIN` fails, and the chain would wait for itself.
		if (this.#inSnapshot) return callback(this);

		return this.#chained(callback);
	}

	/**
	 * Runs `read` in one read transaction, so that each of its reads sees the same committed state. A deferred
	 * `BEGIN` on a read-only connection takes no write lock.
	 */
	snapshot<T>(read: () => Promise<T>): Promise<T> {
		return this.#chained(async () => {
			this.#inSnapshot = true;

			try {
				return await read();
			} finally {
				this.#inSnapshot = false;
			}
		});
	}

	/** Runs `callback` in a transaction after the transactions that came before it. */
	#chained<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
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

	/**
	 * The current session documents of the kind `kind` whose key starts with `prefix`, as key and document ID, in
	 * document ID order. It reads the index of document addresses, and no document record.
	 */
	sessionDocuments(kind: string, prefix: string): Array<{ key: string; id: DocumentId }> {
		// The storage keeps the kind and the key as JSON strings. Escapes go character by character, so the JSON of
		// `prefix` without its closing quote is a prefix of the JSON of each key that starts with `prefix`.
		const start = JSON.stringify(prefix).slice(0, -1);
		const end = start.slice(0, -1) + String.fromCharCode(start.charCodeAt(start.length - 1) + 1);

		const rows = this.#statement(
			"SELECT id, key_value FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = 1 AND key_value >= ? AND key_value < ? AND retired_at IS NULL ORDER BY id",
		).all(JSON.stringify(kind), start, end);

		return rows.flatMap((row) => {
			if (!Value.Check(DOCUMENT_ROW, row)) return [];
			const key: unknown = JSON.parse(row.key_value);

			// SAFETY: `id` is the ID of a document that pi-durable wrote in this store.
			return Value.Check(Type.String(), key) ? [{ key, id: row.id as DocumentId }] : [];
		});
	}

	async close(): Promise<void> {
		this.#statements.clear();
		this.#database.close();
	}
}

export type Store = SqliteStorage;

/** A store open for reads, and the database under it, whose `snapshot` runs reads in one read transaction. */
export type Opened = { readonly store: Store; readonly database: ReadOnlyDatabase };

/**
 * The store at `path`, open for reads with its database, or undefined when it does not exist. A store whose schema
 * pi-durable must update first cannot open read-only; its host updates it when it starts.
 */
export async function openReadOnly(path: string): Promise<Opened | undefined> {
	if (!existsSync(path)) return undefined;
	const database = new ReadOnlyDatabase(path);

	try {
		return { store: await SqliteStorage.open(database), database };
	} catch (error) {
		if (!String(error).includes("readonly")) throw error;
		const host = basename(dirname(path));
		throw new Error(
			`${path} needs a schema update that only its harness host makes: start the host once, such as with harness --host ${host} host, and run the command again`,
		);
	}
}

/**
 * `read` on the store at `path`, open for reads, in one read transaction, so that all its reads see one committed
 * state; `fallback` when the store does not exist.
 */
export async function reading<T>(path: string, fallback: T, read: (opened: Opened) => Promise<T>): Promise<T> {
	const opened = await openReadOnly(path);

	if (opened === undefined) return fallback;

	try {
		return await opened.database.snapshot(() => read(opened));
	} finally {
		await opened.store.close(BACKGROUND_CONTEXT);
	}
}

const NAMED = Type.Object({ name: Type.String() });

/** The workflow name in the input of a workflow task of any version, as the input schema of this version reads it. */
export function inputName(input: JsonValue): string | undefined {
	return Value.Check(NAMED, input) ? input.name : undefined;
}

const WORKTREE = Type.Object({
	worktree: Type.Object({
		repository: Type.String(),
		start: Type.String(),
		branch: Type.String(),
		path: Type.String(),
		renames: Type.Optional(Type.Literal(true)),
	}),
});

/** `A` when `A` and `B` are the same type, else `never`. */
type Exactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? A : never;

/**
 * The worktree that `WORKTREE` reads. It is `never` when the schema and the worktree of `ScriptInput` differ, so a
 * change of one without the other fails the type check of `inputWorktree`.
 */
type SavedWorktree = Exactly<Readonly<Static<typeof WORKTREE>["worktree"]>, NonNullable<ScriptInput["worktree"]>>;

/** The worktree of the input of a workflow task of any version, as the input schema of this version reads it. */
export function inputWorktree(input: JsonValue): SavedWorktree | undefined {
	return Value.Check(WORKTREE, input) ? input.worktree : undefined;
}

/** The tasks of the kind `workflows.run`, root or child, also of another version. */
function scanRuns(store: Store): Promise<RunTask[]> {
	return allPages((cursor) => store.scanTasks({ kind: TASK.name }, 256, cursor, BACKGROUND_CONTEXT));
}

/**
 * The tasks of the kind `workflows.run`, root and child, of every version, by the run ID of their input, in task ID
 * order: a run comes before the runs that start after its first task.
 */
export async function everyRun(store: Store): Promise<Map<string, RunTask[]>> {
	const runs = new Map<string, RunTask[]>();

	for (const task of (await scanRuns(store)).toSorted((a, b) => a.id - b.id)) {
		const id = runIdOf(task);

		if (id !== undefined) runs.set(id, [...(runs.get(id) ?? []), task]);
	}

	return runs;
}

/** The task `id` of the store when it is of the kind `workflows.run`, of any version. */
async function taskById(store: Store, id: number): Promise<RunTask | undefined> {
	// SAFETY: `id` is the ID of a task that harness or pi-durable wrote in this store.
	const task = await store.task(id as TaskId, BACKGROUND_CONTEXT);

	return task?.kind === TASK.name ? task : undefined;
}

/**
 * The root tasks of the kind `workflows.run` whose `start` key starts with `prefix`, by run ID, oldest first, also of
 * another version. It reads the tasks of harness's keys only; without the document of the keys, it reads every task.
 */
async function rootTasks(store: Store, prefix: string): Promise<Map<string, RunTask[]>> {
	const started = await startedTasks(store);

	if (started === undefined) return rootRuns(await scanRuns(store));
	const ids = new Set<number>();

	for (const [key, id] of started) if (key.startsWith(prefix)) ids.add(id);
	const tasks: RunTask[] = [];

	for (const id of [...ids].toSorted((a, b) => a - b)) {
		const task = await taskById(store, id);

		if (task !== undefined) tasks.push(task);
	}

	return rootRuns(tasks);
}

/** The IDs of the tasks of the kind `workflows.run`, root or child, whose status is `running`. */
async function liveTasks(store: Store): Promise<Set<number>> {
	const live = new Set<number>();

	for (const status of ["pending", "running", "waiting", "sleeping"] as const) {
		const query = { kind: TASK.name, status };
		const tasks = await allPages((cursor) => store.scanTasks(query, 256, cursor, BACKGROUND_CONTEXT));

		for (const task of tasks) if (runStatus(task) === "running") live.add(task.id);
	}

	return live;
}

/** The task IDs of harness's lists of todos of tasks, in ascending order. */
async function todoTasks(store: Store): Promise<number[]> {
	const query = { scope: { kind: "session" as const }, at: "current" as const, kind: TASK_TODO_LIST_KIND };
	const records = await allPages((cursor) => store.scanDocuments(query, 256, cursor, BACKGROUND_CONTEXT));

	return records.flatMap((record) => (record.key === undefined ? [] : [Number(record.key)])).toSorted((a, b) => a - b);
}

/**
 * The list of todos of each child run of `children`, the task of its `run` record by run ID, in the order of
 * `children`: the list of the first task of the run after `first`, the first task of the root run, or empty.
 */
async function childTodos(
	store: Store,
	first: RunTask | undefined,
	children: ReadonlyMap<string, number>,
): Promise<Map<string, Todo[]>> {
	const found = new Map<string, Todo[]>();

	if (children.size === 0) return found;
	const after = first?.id ?? 0;
	const last = Math.max(...children.values());

	for (const id of await todoTasks(store)) {
		if (id > last) break;

		const task = id > after ? await taskById(store, id) : undefined;

		if (task === undefined) continue;
		const runId = [...children.keys()].find((child) => !found.has(child) && isOfRun(task, child));

		if (runId !== undefined) found.set(runId, await todosOf(store, task));
	}

	return new Map([...children.keys()].map((runId) => [runId, found.get(runId) ?? []]));
}

/**
 * The tasks of the kind `workflows.run` that no task owns, so not the tasks of child runs, by run ID, oldest first,
 * also of another version: the tasks of harness's `wf:` keys.
 */
export function runTasks(store: Store): Promise<Map<string, RunTask[]>> {
	return rootTasks(store, "wf:");
}

/** The list of todos of the task `task`, or empty when it has no list. */
async function todosOf(store: Store, task: RunTask): Promise<Todo[]> {
	return (await readTodos(todoReader(store), { kind: "task", id: task.id }, BACKGROUND_CONTEXT)).todos;
}

/** The reader of `readTodos` over `store`: `readTodos` reads the list of a task, a document of a session family. */
function todoReader(store: Store): Pick<DocumentReader, "snapshot"> {
	const snapshot = <T extends JsonObject>(token: SessionDocFamilyToken<T, JsonValue>, key: string, context: Context) =>
		sessionDocument(store, token, key, context);

	// SAFETY: `readTodos` reads the list of a task with `(token, key, context)` only.
	return { snapshot } as Pick<DocumentReader, "snapshot">;
}

/**
 * The task ID of each `start` key of the host, from harness's document of the keys; undefined when the store has no
 * such document, or one of another version.
 */
export async function startedTasks(store: Store): Promise<ReadonlyMap<string, number> | undefined> {
	const value = await sessionDocument(store, StartedTasks, undefined, BACKGROUND_CONTEXT);

	return value === undefined ? undefined : new Map(Object.entries(value.tasks));
}

/**
 * The current session document of `token` in `store`, at the family key `key` for a family. A document of another
 * version than the one of `token` reads as absent.
 */
async function sessionDocument<T extends JsonObject>(
	store: Store,
	token: SessionDocToken<T> | SessionDocFamilyToken<T, JsonValue>,
	key: string | undefined,
	context: Context,
): Promise<Readonly<T> | undefined> {
	const { kind, scope, version } = token.definition;
	const address = key === undefined ? { kind, scope: { kind: scope } } : { kind, scope: { kind: scope }, key };
	const record = await store.findDocument(address, "current", context);
	const stored = record === undefined ? undefined : await store.document(record.id, "current", context);

	if (stored?.version !== version) return undefined;

	// SAFETY: harness writes a document of the kind of `token` only through that token, at the version checked above.
	return stored.value as T;
}

const PROGRESS = Type.Object({ events: Type.Array(Type.Unknown()) });

/** The progress events of the root run `id`, without an event that is not valid. */
export async function progressEvents(store: Store, id: string): Promise<readonly ProgressEvent[]> {
	const address = { kind: PROGRESS_KIND, scope: { kind: "session" as const }, key: id };
	const record = await store.findDocument(address, "current", BACKGROUND_CONTEXT);

	if (record === undefined) return [];
	const stored = await store.document(record.id, "current", BACKGROUND_CONTEXT);
	const value = stored?.value;

	if (!Value.Check(PROGRESS, value)) return [];

	return value.events.filter((event) => Value.Check(PROGRESS_EVENT, event));
}

/**
 * The call records of the run `runId` and of its child runs, by key, in document order for each run. It lists the keys
 * of each run by key prefix, and reads only those documents.
 */
export async function callRecords({ store, database }: Opened, runId: string): Promise<Map<string, SavedCall>> {
	const records = new Map<string, SavedCall>();
	const runs = [runId];

	for (const run of runs) {
		for (const { key, id } of database.sessionDocuments(CALL_KIND, callPrefix(run))) {
			const stored = await store.document(id, "current", BACKGROUND_CONTEXT);
			const record = stored?.value;

			if (!Value.Check(CALL_RECORD, record)) continue;
			records.set(key, record);

			const child = childOf(record);

			if (child !== undefined) runs.push(child.runId);
		}
	}

	return records;
}

/**
 * What the store keeps of the root run `id`: its root tasks, oldest first, its progress events and their steps, its
 * call records and those of its child runs, the IDs of the tasks that run, the task of each `run` record by task ID,
 * and the list of todos of the run and of each child run in its call records.
 */
export type RunRecords = {
	readonly tasks: readonly RunTask[];
	readonly children: ReadonlyMap<number, RunTask>;
	readonly events: readonly ProgressEvent[];
	readonly progress: Progress;
	readonly records: Map<string, SavedCall>;
	readonly live: ReadonlySet<number>;
	readonly todos: ReadonlyMap<string, Todo[]>;
};

/**
 * The records of the root run `id` in the store at `path`, in one read; none when the store does not exist. It reads
 * the call records only when `withCalls` of the steps of the progress events is true.
 */
export async function runRecords(
	path: string,
	id: string,
	withCalls: (progress: Progress) => boolean,
): Promise<RunRecords> {
	const empty = {
		tasks: [],
		children: new Map<number, RunTask>(),
		events: [],
		progress: progressOf([]),
		records: new Map<string, SavedCall>(),
		live: new Set<number>(),
		todos: new Map<string, Todo[]>(),
	};

	return reading(path, empty, async (opened) => {
		const { store } = opened;
		const events = await progressEvents(store, id);
		const progress = progressOf(events);
		const records = withCalls(progress) ? await callRecords(opened, id) : new Map<string, SavedCall>();
		const tasks = (await rootTasks(store, `wf:${id}#`)).get(id) ?? [];
		const childRuns = new Map<string, number>();

		for (const record of records.values()) {
			const child = childOf(record);

			if (child !== undefined) childRuns.set(child.runId, child.task);
		}

		const children = new Map<number, RunTask>();

		for (const task of childRuns.values()) {
			const read = await taskById(store, task);

			if (read !== undefined) children.set(task, read);
		}

		const root = tasks[0] === undefined ? [] : await todosOf(store, tasks[0]);
		const todos = new Map([[id, root], ...(await childTodos(store, tasks[0], childRuns))]);

		return { tasks, children, events, progress, records, live: await liveTasks(store), todos };
	});
}
