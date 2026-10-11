/** Run IDs: `<UTC timestamp>-<8 hex>`, so a sort by name is a sort by start time. */
import { randomBytes } from "node:crypto";

export function newRunId(): string {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	return `${stamp}-${randomBytes(4).toString("hex")}`;
}
