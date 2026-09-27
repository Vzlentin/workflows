Rules for code in this repository. Cite a rule by its bold name. A rule here overrides a generic
review baseline. Ruff owns formatting and lint, so nothing here restates it. When a rule can
become a ruff setting or a test, make it one and delete it from this file.

## Architecture

- **Prompts are the optimizable surface.** Every turn the engine sends, except the fixed judge,
  is a `dspy.Predict` whose instructions are a template in `prompts/`, called through
  `Conversation` so its trace holds what the turn saw. Prompt wording belongs in the template.
  Only output the engine parses, such as the SHIP or FIX field `desc`, is fixed in code, so GEPA
  can rewrite a template without breaking the engine.
- **Git is the only state.** Nothing the engine writes decides what a later run does. Commits,
  trailers and branches are the record, and a run resumes with `--base ship/<run>`.
- **Check inputs at the edge.** Validate CLI arguments and work items before a worktree or
  session exists, and git, Pi and Herdr output where it is read. Code inside trusts its inputs: no
  re-checks, and no defaults that hide a missing value.
- **Replace, don't shim.** A new API, flag or command replaces the old one in the same change.
  Migrate the callers and delete the old path: no aliases, deprecations or dual paths.

## Style

- **README words.** Name things with the README's vocabulary: work item, round, session,
  worktree, run directory, judge.
- **Docstrings state the contract.** Each `src/` module opens with a docstring that says what it
  is. A function or class docstring states what it returns or guarantees, as a fact ("A worktree
  at a commit, on a new branch or detached; the checkout stays untouched."), not the steps.
- **Comments state constraints.** A comment says only what the code cannot show. No narration,
  history or TODOs.
- **Errors carry evidence.** Raise `RuntimeError` with what failed and its output, or
  `ValueError` for bad user input. No custom exception classes. Catch broadly only where the run
  can go on, and say why in the `noqa`.
- **Functions and frozen dataclasses first.** Use a plain class only when it holds a live
  resource or state across calls (`Pi`, `Session`, `Conversation`), or when DSPy needs a subclass.
- **Few, pinned dependencies.** Use the standard library, then `dspy` and `gepa`. Add a new
  dependency only when a work item asks for it, pinned with `==` and locked with `uv lock`.

## Testing

- **Fakes, not mocks.** Tests run the real code against `tests/fake_pi.py`,
  `tests/fake_herdr.py` and temporary git repositories. `monkeypatch` sets only environment
  variables and `PATH`. Never patch our own functions.
- **Assert what a user sees.** Call `main`, `ship.ship`, `Ship` or a public function the way a
  user does, and assert literal outcomes: commit subjects, trailers, file contents, prompts sent,
  session order. If a test would still pass when every imported function returned `None`, rewrite
  it or delete it.
- **Grow the flow test.** New behaviour adds assertions to the test that already runs its flow,
  or one new test. No per-function suites: the flow tests are long on purpose.
