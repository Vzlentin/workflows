/**
 * A list to pick one item of on a terminal: typed text filters the items, moves change the item under the cursor, and
 * Enter takes it. The terminal decodes its keys into actions.
 */

/** The state of a pick: the filter text and the item under the cursor among the matching items. */
export type Pick = { readonly query: string; readonly cursor: number };

/** What a key does: the next state, the index of the taken item, or a cancel. */
type Step = { readonly pick: Pick } | { readonly taken: number } | { readonly cancelled: true };

/** The indexes of the items that contain each word of `query`, in any case. */
export function matching(items: readonly string[], query: string): number[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);

	return items.flatMap((item, index) => (words.every((word) => item.toLowerCase().includes(word)) ? [index] : []));
}

/** A key of the pick, decoded by the terminal: a move, Enter, a cancel, Backspace, or typed text. */
export type Action =
	| { readonly type: "move"; readonly by: 1 | -1 }
	| { readonly type: "enter" | "cancel" | "backspace" }
	| { readonly type: "text"; readonly text: string };

/** The pick of `query` over `items`, with the cursor on the first match that `pickable` flags, else on the first match. */
export function startPick(items: readonly string[], pickable: readonly boolean[], query: string): Pick {
	const cursor = matching(items, query).findIndex((index) => pickable[index] === true);

	return { query, cursor: Math.max(cursor, 0) };
}

/**
 * What `action` does to `pick` over `items`. A new filter text starts the cursor on the first match that `pickable`
 * flags, and Enter on an item that it does not flag keeps the pick open.
 */
export function press(items: readonly string[], pickable: readonly boolean[], pick: Pick, action: Action): Step {
	const shown = matching(items, pick.query);

	switch (action.type) {
		case "text":
			return { pick: startPick(items, pickable, pick.query + action.text) };
		case "backspace":
			return { pick: startPick(items, pickable, pick.query.slice(0, -1)) };
		case "cancel":
			return { cancelled: true };
		case "enter": {
			const index = shown[pick.cursor];

			return index === undefined || pickable[index] !== true ? { pick } : { taken: index };
		}

		case "move": {
			const cursor = shown.length === 0 ? 0 : (pick.cursor + action.by + shown.length) % shown.length;

			return { pick: { ...pick, cursor } };
		}
	}
}

/**
 * The lines of `pick` for a terminal of `rows` rows: the question with the filter, then the matching items, the one
 * under the cursor with `›`, at most enough to fit, scrolled to keep the cursor in view.
 */
export function render(question: string, items: readonly string[], pick: Pick, rows: number): string[] {
	const shown = matching(items, pick.query);
	const room = Math.max(rows - 2, 1);
	const first = Math.min(Math.max(pick.cursor - room + 1, 0), Math.max(shown.length - room, 0));
	const head = `${question} ${pick.query}`;

	if (shown.length === 0) return [head, "  nothing matches"];

	return [
		head,
		...shown
			.slice(first, first + room)
			.map((index, at) => `${first + at === pick.cursor ? "›" : " "} ${items[index] ?? ""}`),
	];
}
