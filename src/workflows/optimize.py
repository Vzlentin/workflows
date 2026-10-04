"""The optimize engine: GEPA rewrites the ship prompts using rollout scores.

A rollout ships one work item from the base commit in its own detached worktree under
`<run>/rollouts/`. Blocked rollouts score 0; the judge scores the others. The templates GEPA
changed are written back to `prompts/`.
"""

import tempfile
from contextlib import closing
from pathlib import Path

import dspy

from workflows import prompts, ship, workspace
from workflows.judge import judge
from workflows.pi import Pi


class Rollout(ship.Ship):
    def __init__(
        self, root: Path, base: str, run: Path, command: str, herdr: str | None, rounds: int
    ):
        super().__init__(rounds)
        self.root = root
        self.base = base
        self.run = run
        self.command = command
        self.herdr = herdr

    def forward(self, item: str, path: str) -> dspy.Prediction:
        """The judge's score and findings for `item`, or score 0 and the reply when blocked.
        The rollout's worktree is removed; any error ends the run as SystemExit."""
        try:
            (self.run / "rollouts").mkdir(parents=True, exist_ok=True)
            folder = Path(tempfile.mkdtemp(dir=self.run / "rollouts"))
            workspace.add_worktree(self.root, self.base, folder / "worktree")
            try:
                pi = Pi(folder / "sessions", folder / "worktree", self.command, self.herdr)
                result = super().forward(pi, item)
                if result.status == "blocked":
                    return dspy.Prediction(
                        score=0,
                        feedback=(
                            f"Did not ship: blocked in round {result.rounds} with "
                            "no changes from the round's starting commit.\n"
                            f"{result.reply}"
                        ),
                    )
                judge_pi = Pi(folder / "sessions", folder / "judge", self.command, self.herdr)
                verdict = judge(judge_pi, self.root, item, self.base, result.head)
            finally:
                workspace.remove_worktree(self.root, folder / "worktree")
        except Exception as error:
            # DSPy's evaluator would score an Exception as 0; SystemExit ends the run instead.
            raise SystemExit(f"rollout of {path} failed: {error}") from error
        if result.status == "shipped":
            outcome = f"The review said SHIP in round {result.rounds}."
        else:
            outcome = f"Did not ship: the review still said FIX after {result.rounds} rounds."
        return dspy.Prediction(
            score=verdict.score, feedback="\n".join([*verdict.findings, outcome])
        )


def metric(gold, pred, trace=None, pred_name=None, pred_trace=None) -> dspy.Prediction:
    return pred


def optimize(
    repository: str,
    base: str,
    items: list[Path],
    run: Path,
    budget: int,
    rounds: int = 3,
    command: str = "pi",
    herdr: str | None = None,
) -> None:
    """Run GEPA over the items for about `budget` rollouts, and write each template it changed
    back to `prompts/`. A run resumes from GEPA's state in `run/gepa`."""
    examples = [
        dspy.Example(item=ship.read_item(path), path=str(path)).with_inputs("item", "path")
        for path in items
    ]
    root = workspace.repository_root(repository)
    commit = workspace.resolve_commit(root, base)
    reflections = Pi(run / "sessions", root, command, herdr)

    def reflect(prompt: str) -> list[str]:
        try:
            with closing(reflections.open(ship.PLANNER, "reflect")) as session:
                return [session.prompt(prompt)]
        except Exception as error:
            # GEPA's proposer would skip a failed reflection and still spend the budget.
            raise SystemExit(f"reflection failed: {error}") from error

    optimizer = dspy.GEPA(
        metric,
        max_metric_calls=budget,
        reflection_lm=reflect,
        num_threads=1,
        log_dir=str(run / "gepa"),
        track_stats=True,
    )
    program = optimizer.compile(
        Rollout(root, commit, run, command, herdr, rounds), trainset=examples, valset=examples
    )
    seed = dict(program.detailed_results.candidates[0].named_predictors())
    for name, predictor in program.named_predictors():
        if predictor.signature.instructions != seed[name].signature.instructions:
            prompts.save(name, predictor.signature.instructions)
            print(f"changed prompts/{name}.md")
