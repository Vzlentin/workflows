/** The keys of the terminal as actions of a pick, decoded by Pi's key parser, so every key encoding reads the same. */
import { decodeKittyPrintable, Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { Action } from "./pick.ts";

/** The keys of each action of the pick. */
const KEYS: readonly (readonly [Action, readonly KeyId[]])[] = [
	[{ type: "enter" }, [Key.enter]],
	[{ type: "cancel" }, [Key.escape, Key.ctrl("c")]],
	[{ type: "move", by: -1 }, [Key.up, Key.ctrl("p")]],
	[{ type: "move", by: 1 }, [Key.down, Key.ctrl("n")]],
	[{ type: "backspace" }, [Key.backspace]],
];

/** The action of `key`, one whole key as `StdinBuffer` gives it, or undefined for any other key. */
export function actionOf(key: string): Action | undefined {
	const named = KEYS.find(([, ids]) => ids.some((id) => matchesKey(key, id)))?.[0];

	if (named !== undefined) return named;
	const text = decodeKittyPrintable(key) ?? (/^[^\p{Cc}]+$/u.test(key) ? key : undefined);

	return text === undefined ? undefined : { type: "text", text };
}
