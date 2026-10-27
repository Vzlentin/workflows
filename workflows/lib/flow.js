// Script lib: run calls at once.

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
