// Script lib: run calls at once.
// It runs in the sandbox after the prelude of script.ts, so it uses only the script calls. A script's own
// declarations shadow these names.

/** Runs every thunk at once and gives their results in order. */
const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()));

/** Passes each item through the stages in order, all items at once, and gives the results in item order. */
const pipeline = (items, ...stages) =>
	Promise.all(
		items.map(async (item) => {
			let value = item;

			for (const stage of stages) value = await stage(value);

			return value;
		}),
	);
