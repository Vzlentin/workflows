import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The lock of the run in `directory`, an exclusive transaction on `lock.sqlite`, held until `close()`. The system
 * drops it when the process ends. It throws when another process holds it.
 */
export function takeLock(directory: string, id: string): DatabaseSync {
	const database = new DatabaseSync(join(directory, "lock.sqlite"), { timeout: 0 });
	try {
		database.exec("BEGIN EXCLUSIVE");
		return database;
	} catch {
		database.close();
		throw new Error(`run ${id} is running`);
	}
}
