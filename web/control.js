/**
 * The browser side of `workflows web`, with no dependencies. `mountControl` draws the control center: on the left, the
 * runs of the projects, a form that starts a run, and the steps and actions of the selected run; on the right, the
 * inspect view of harness for the agent of a step, or for an agent of a host. It needs the routes of `workflows web` and
 * of harness inspect on the same origin.
 *
 * Every text goes into the page with `textContent`: titles, steps and reports come from runs and agents, so they are
 * never HTML.
 */

import { mountInspect } from "/assets/inspect.js";

/** How long the run list waits after a read of the runs ends before it reads them again. */
const RUNS_POLL_MS = 2000;

/** The badges of a run whose task ended and that a resume continues. */
const RESUMABLE = new Set(["stopped", "failed"]);

/** A new element with the class `className`, and the text `text` when it is given. */
function el(tag, className, text) {
	const node = document.createElement(tag);

	if (className) node.className = className;

	if (text !== undefined) node.textContent = text;

	return node;
}

function button(text, className) {
	const node = el("button", className, text);
	node.type = "button";

	return node;
}

/** A `select` element with the options `options`, each `{ value, text }`, and `value` selected when it is one of them. */
function fillSelect(select, options, value) {
	select.replaceChildren(
		...options.map((option) => {
			const node = el("option", "", option.text);
			node.value = option.value;

			return node;
		}),
	);

	if (options.some((option) => option.value === value)) select.value = value;
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The JSON of a route, as `{ ok: true, value }`, or `{ ok: false, error }` with the error of the route. */
async function call(path, init) {
	try {
		const response = await fetch(path, init);
		const value = await response.json();

		return response.ok ? { ok: true, value } : { ok: false, error: value.error ?? response.statusText };
	} catch (error) {
		return { ok: false, error: errorText(error) };
	}
}

function post(path, body) {
	return call(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** `path` with the query of `fields`, without the fields that are empty. */
function withQuery(path, fields) {
	const query = new URLSearchParams();

	for (const [key, value] of Object.entries(fields)) if (value) query.set(key, value);
	const text = query.toString();

	return text === "" ? path : `${path}?${text}`;
}

const runPath = (runId, action) => `/api/runs/${encodeURIComponent(runId)}${action ? `/${action}` : ""}`;

/**
 * Draws the control center in `container`, and follows the runs until `close()`. The run list reads the runs every
 * 2 s, and the selected run follows the stream of its snapshots.
 */
export function mountControl(container) {
	const root = el("div", "control");
	const runsPane = el("section", "control-runs");
	const agentPane = el("section", "control-agent");
	root.append(runsPane, agentPane);
	container.replaceChildren(root);

	let runsText = "";
	let selected;
	let events;
	let view;
	let openKey;
	let timer;
	let closed = false;

	// The head: the title, the project filter, and the prune button.
	const head = el("header", "control-head");
	const title = el("h1", "", "workflows web");
	const filter = el("select", "control-filter");
	filter.title = "Project";
	const pruneButton = button("Prune");
	pruneButton.title = "Remove the worktrees and branches of the ended runs whose branch is merged";
	head.append(title, filter, pruneButton);
	const notice = el("div", "control-notice");

	// The form that starts a run.
	const form = el("form", "control-start");
	const workflow = el("select");
	workflow.title = "Workflow";
	const text = el("textarea");
	text.rows = 2;
	text.placeholder = "Work item or goal, as text or as the path of a .md file";
	const repo = el("input");
	repo.placeholder = "--repo";
	const agents = el("input");
	agents.placeholder = "--agents <name>=<provider/id>:<thinking>,...";
	const startButton = el("button", "", "Start");
	startButton.type = "submit";
	const options = el("div", "control-options");
	options.append(repo, agents, startButton);
	form.append(workflow, text, options);

	const list = el("ul", "control-list");

	// The selected run: its head, its actions, its question, its steps and its footer.
	const run = el("div", "control-run");
	const runHead = el("div", "control-run-head");
	const actions = el("div", "control-actions");
	const stopButton = button("Stop", "stop");
	const resumeButton = button("Resume");
	actions.append(stopButton, resumeButton);
	const answerForm = el("form", "control-answer");
	const question = el("div", "control-question");
	const answer = el("input");
	answer.placeholder = "Answer";
	const answerButton = el("button", "", "Send Answer");
	answerButton.type = "submit";
	answerForm.append(question, answer, answerButton);
	const steps = el("div", "control-steps");
	const footer = el("div", "control-footer");
	const runNotice = el("div", "control-notice");
	run.append(runHead, actions, answerForm, steps, footer, runNotice);
	run.hidden = true;

	runsPane.append(head, notice, form, list, run);

	// The right pane: the bar that opens an agent of a host, and the inspect view.
	const bar = el("form", "control-bar");
	const barProject = el("select");
	barProject.title = "Project";
	const barTarget = el("select");
	barTarget.title = "Agent";
	const openButton = el("button", "", "Open");
	openButton.type = "submit";
	bar.append(barProject, barTarget, openButton);
	const viewBody = el("div", "control-view");
	viewBody.append(el("p", "muted-line", "Click a step with a #conversation, or open an agent above."));
	agentPane.append(bar, viewBody);

	/** `body` with the selected project as its `project`, and without `project` when no project is selected. */
	const inProject = (body) => {
		if (filter.value !== "") body.project = filter.value;

		return body;
	};

	/** The key of a conversation of a project, as the pills and the inspect view name it. */
	const keyOf = (project, conversation) => `${project}#${conversation}`;

	/** Marks the pill of the conversation that the inspect view shows. */
	const markOpen = () => {
		for (const pill of steps.querySelectorAll(".control-pill"))
			pill.classList.toggle("open", pill.dataset.key === openKey);
	};

	/** Closes the inspect view, and shows `target` in its place. */
	const openAgent = (target) => {
		view?.close();
		openKey = target.conversation === undefined ? undefined : keyOf(target.project, target.conversation);
		viewBody.replaceChildren();

		view = mountInspect(viewBody, target, {
			onTitle: (agentTitle) => {
				document.title = `${agentTitle} · workflows web`;
			},
		});

		markOpen();
	};

	const drawRuns = (runs) => {
		list.replaceChildren();

		if (runs.length === 0) list.append(el("li", "muted-line", "no runs"));

		for (const listed of runs) {
			const item = el("li", listed.runId === selected ? "selected" : "");
			const line = el("div", "control-line");
			line.append(el("span", `control-badge ${listed.badge}`, listed.badge), el("span", "", ` ${listed.title}`));
			const meta = `${listed.workflow} · ${listed.status} · ${listed.project} · ${listed.runId}`;
			item.append(line, el("div", "muted-line", meta));
			item.addEventListener("click", () => selectRun(listed.runId));
			list.append(item);
		}
	};

	const refreshRuns = async () => {
		const reply = await call(withQuery("/api/runs", { project: filter.value }));

		if (closed) return;

		if (!reply.ok) {
			notice.textContent = `runs: ${reply.error}`;

			return;
		}

		const json = JSON.stringify([reply.value.runs, selected]);

		if (json === runsText) return;
		runsText = json;
		drawRuns(reply.value.runs);
	};

	const pollRuns = () => {
		timer = setTimeout(async () => {
			await refreshRuns();

			if (!closed) pollRuns();
		}, RUNS_POLL_MS);
	};

	const drawRun = (snapshot) => {
		runHead.replaceChildren(
			el("span", `control-badge ${snapshot.badge}`, snapshot.badge),
			el("span", "control-run-title", ` ${snapshot.title}`),
			el("div", "muted-line", `${snapshot.workflow} · ${snapshot.status} · ${snapshot.project} · ${snapshot.runId}`),
		);

		stopButton.hidden = snapshot.ended;
		resumeButton.hidden = !snapshot.ended || !RESUMABLE.has(snapshot.badge);
		answerForm.hidden = snapshot.status !== "waiting";
		question.textContent = snapshot.waitingQuestion ?? "";
		steps.replaceChildren();

		for (const entry of snapshot.entries) {
			const row = el("div", "control-step");
			row.append(el("span", "control-step-text", entry.text));

			if (entry.conversation !== undefined) {
				const conversation = String(entry.conversation);
				const pill = el("span", "control-pill", `#${conversation}`);
				pill.dataset.key = keyOf(snapshot.project, conversation);
				row.append(pill);
				row.classList.add("agent");
				row.addEventListener("click", () => openAgent({ project: snapshot.project, conversation }));
			}

			steps.append(row);
		}

		footer.replaceChildren(...snapshot.footer.map((line) => el("div", "", line)));
		const error = snapshot.end !== null && "error" in snapshot.end ? snapshot.end.error : undefined;
		footer.classList.toggle("error-line", error !== undefined);
		markOpen();
	};

	const selectRun = (runId) => {
		events?.close();
		selected = runId;
		run.hidden = false;
		runNotice.textContent = "";
		answer.value = "";
		runHead.replaceChildren(el("span", "muted-line", `run ${runId}`));
		steps.replaceChildren();
		footer.replaceChildren();
		stopButton.hidden = true;
		resumeButton.hidden = true;
		answerForm.hidden = true;
		void refreshRuns();
		const stream = new EventSource(runPath(runId, "stream"));
		events = stream;

		stream.addEventListener("message", (event) => {
			if (selected === runId) drawRun(JSON.parse(event.data));
		});

		stream.addEventListener("error", () => {
			if (stream.readyState !== EventSource.CLOSED) return;

			void call(runPath(runId)).then((reply) => {
				if (selected === runId) runNotice.textContent = reply.ok ? "the stream ended" : reply.error;
			});
		});
	};

	/** Runs the action `act` of the selected run with `buttons` off, and shows its error. */
	const runAction = async (buttons, act) => {
		for (const node of buttons) node.disabled = true;
		runNotice.textContent = "";
		const reply = await act();

		for (const node of buttons) node.disabled = false;

		if (!reply.ok) runNotice.textContent = reply.error;
		else void refreshRuns();

		return reply.ok;
	};

	stopButton.addEventListener("click", () => {
		void runAction([stopButton], () => post(runPath(selected, "stop"), {}));
	});

	resumeButton.addEventListener("click", () => {
		void runAction([resumeButton], () => post(runPath(selected, "resume"), {}));
	});

	answerForm.addEventListener("submit", async (event) => {
		event.preventDefault();
		const sent = await runAction([answerButton], () => post(runPath(selected, "resume"), { answer: answer.value }));

		if (sent) answer.value = "";
	});

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		startButton.disabled = true;
		notice.textContent = "";
		const args = [];

		if (repo.value.trim() !== "") args.push(`--repo=${repo.value.trim()}`);

		if (agents.value.trim() !== "") args.push(`--agents=${agents.value.trim()}`);

		// After `--`, a text that starts with `-`, such as a Markdown list, is not an option.
		if (text.value.trim() !== "") args.push("--", text.value);
		const reply = await post("/api/runs/start", inProject({ workflow: workflow.value, args }));
		startButton.disabled = false;

		if (!reply.ok) {
			notice.textContent = reply.error;

			return;
		}

		text.value = "";
		selectRun(reply.value.runId);
	});

	pruneButton.addEventListener("click", async () => {
		const where = filter.value === "" ? "the project of the server" : filter.value;

		if (!confirm(`Remove the worktrees and branches of the ended runs of ${where} whose branch is merged?`)) return;
		pruneButton.disabled = true;
		notice.textContent = "";
		const reply = await post("/api/runs/prune", inProject({}));
		pruneButton.disabled = false;
		notice.textContent = reply.ok ? `pruned: ${reply.value.pruned.join(" ") || "none"}` : reply.error;
		void refreshRuns();
	});

	const loadWorkflows = async () => {
		const reply = await call(withQuery("/api/workflows", { project: filter.value }));

		if (!reply.ok) {
			notice.textContent = `workflows: ${reply.error}`;

			return;
		}

		const names = reply.value.workflows.map(({ name, description }) => ({
			value: name,
			text: description === "" ? name : `${name}: ${description}`,
		}));

		fillSelect(workflow, names, workflow.value || "ship");
	};

	const loadTargets = async () => {
		const project = barProject.value;
		const reply = await call(withQuery("/api/inspect/targets", { project }));

		if (project !== barProject.value) return;

		const targets = reply.ok
			? reply.value.targets.map((target) => ({ value: target.handle, text: `${target.title} (${target.state})` }))
			: [];

		// A host that does not run has its agent only, and opening it starts the host.
		fillSelect(barTarget, targets.length === 0 ? [{ value: "agent", text: "agent" }] : targets, barTarget.value);
	};

	filter.addEventListener("change", () => {
		runsText = "";
		void loadWorkflows();
		void refreshRuns();
	});

	barProject.addEventListener("change", () => void loadTargets());
	barProject.addEventListener("focus", () => void loadTargets());

	bar.addEventListener("submit", (event) => {
		event.preventDefault();

		if (barProject.value !== "") openAgent({ project: barProject.value, handle: barTarget.value || "agent" });
	});

	void (async () => {
		const reply = await call("/api/inspect/projects");

		if (!reply.ok) notice.textContent = `projects: ${reply.error}`;
		const names = (reply.ok ? reply.value.projects : []).map(({ name }) => ({ value: name, text: name }));
		fillSelect(filter, [{ value: "", text: "all projects" }, ...names], "");
		fillSelect(barProject, names, "main");
		await Promise.all([loadWorkflows(), refreshRuns(), loadTargets()]);

		if (!closed) pollRuns();
	})();

	return {
		close() {
			closed = true;
			clearTimeout(timer);
			events?.close();
			view?.close();
			root.remove();
		},
	};
}
