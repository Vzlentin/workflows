"""The ship engine: each work item is planned, then implemented and reviewed for a few rounds.

Every box is one fresh Pi session; its turns are the predictors below, whose instructions are the
templates in `prompts/`. Git is the only state: one squashed commit per shipped item.
"""

import os
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import dspy

from workflows import prompts, workspace
from workflows.judge import Verdict, judge
from workflows.pi import READ_ONLY, Agent, Pi, SessionLM
from workflows.workspace import git

PLANNER = Agent("cursor/claude-fable-5-1", "high", READ_ONLY)
IMPLEMENTER = Agent("openai-codex/gpt-5.6-sol", "xhigh", (*READ_ONLY, "bash", "edit", "write"))


class Plan(dspy.Signature):
    item: str = dspy.InputField()
    text: str = dspy.OutputField()


class Challenge(dspy.Signature):
    text: str = dspy.OutputField()
    verdict: Literal["SHIP", "FIX"] = dspy.OutputField()


class Handoff(dspy.Signature):
    text: str = dspy.OutputField()


class Implement(dspy.Signature):
    plan: str = dspy.InputField()
    text: str = dspy.OutputField()


class Review(dspy.Signature):
    item: str = dspy.InputField()
    plan: str = dspy.InputField()
    change: str = dspy.InputField()
    text: str = dspy.OutputField()


def template(signature: type[dspy.Signature], name: str) -> dspy.Predict:
    return dspy.Predict(signature.with_instructions(prompts.load(name)))


@contextmanager
def session(pi: Pi, label: str, agent: Agent):
    """Predictors called inside are turns of one Pi session, closed on every path."""
    opened = pi.open(agent, label)
    try:
        with dspy.context(lm=SessionLM(opened), adapter=prompts.Template()):
            yield
    finally:
        opened.close()


class Ship(dspy.Module):
    def __init__(self, rounds: int = 3):
        super().__init__()
        self.plan = template(Plan, "plan")
        self.challenge = template(Challenge, "challenge")
        self.handoff = template(Handoff, "handoff")
        self.implement = template(Implement, "implement")
        self.review = template(Review, "review")
        self.rounds = rounds

    def forward(self, pi: Pi, item: str) -> dspy.Prediction:
        start = git(pi.cwd, "rev-parse", "HEAD")
        with session(pi, "plan", PLANNER):
            self.plan(item=item)
            self.challenge()
            plan = self.handoff().text
        for n in range(1, self.rounds + 1):
            before = git(pi.cwd, "rev-parse", "HEAD")
            with session(pi, "implement", IMPLEMENTER):
                self.implement(plan=plan)
            git(pi.cwd, "add", "-A")
            git(pi.cwd, "commit", "--allow-empty", "-m", f"round {n}")
            change = [patch(pi, f"round-{n}.patch", start)]
            if n > 1:
                change.append(patch(pi, f"round-{n}-fix.patch", before))
            with session(pi, "review", PLANNER):
                self.review(item=item, plan=plan, change="\n".join(change))
                if self.challenge().verdict == "SHIP":
                    return dspy.Prediction(status="shipped", rounds=n, start=start)
                plan = self.handoff().text
        return dspy.Prediction(status="stopped", rounds=self.rounds, start=start)


def patch(pi: Pi, name: str, base: str) -> str:
    path = pi.directory / name
    path.write_text(git(pi.cwd, "diff", "--binary", base, "HEAD") + "\n")
    return str(path)


def message(item: str, rounds: int, verdict: Verdict | None = None) -> str:
    subject = next(line for line in item.splitlines() if line.strip()).lstrip("#").strip()
    paragraphs = [subject, item.strip()]
    trailers = [f"Rounds: {rounds}"]
    if verdict:
        paragraphs += ["\n".join(verdict.findings)] if verdict.findings else []
        trailers.append(f"Judge: {verdict.score:.2f}")
    return "\n\n".join([*paragraphs, "\n".join(trailers)])


def run_directory() -> Path:
    home = os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    stamp = time.strftime("%Y%m%dT%H%M%S")
    return Path(home) / "workflows" / "runs" / f"{stamp}-{uuid.uuid4().hex[:8]}"


def ship(
    repository: str,
    base: str,
    items: list[Path],
    directory: Path,
    rounds: int = 3,
    command: str = "pi",
    herdr: str | None = None,
) -> bool:
    """Ship the items in order onto `ship/<run>`; stop at the first one that does not ship."""
    texts = [item.read_text() for item in items]
    root = workspace.repository_root(repository)
    commit = workspace.resolve_commit(root, base)
    worktree = directory / "worktree"
    workspace.add_worktree(root, commit, worktree, branch=f"ship/{directory.name}")
    pi = Pi(directory / "sessions", worktree, command, herdr)
    judge_pi = Pi(directory / "sessions", directory / "judge", command, herdr)
    program = Ship(rounds)
    for item, text in zip(items, texts, strict=True):
        result = program(pi=pi, item=text)
        if result.status == "stopped":
            print(f"stopped at {item} after {rounds} rounds: {worktree}")
            return False
        git(worktree, "reset", "--soft", result.start)
        git(worktree, "commit", "--allow-empty", "-m", message(text, result.rounds))
        head = git(worktree, "rev-parse", "HEAD")
        try:
            verdict = judge(judge_pi, root, text, result.start, head)
        except Exception as error:  # noqa: BLE001 - the commit stands without a score
            print(f"judge failed on {item}: {error}", file=sys.stderr)
            score = "failed"
        else:
            git(worktree, "commit", "--amend", "-m", message(text, result.rounds, verdict))
            score = f"{verdict.score:.2f}"
        sha = git(worktree, "rev-parse", "--short", "HEAD")
        print(f"shipped {item} in {result.rounds} rounds, judge {score}, {sha}")
    return True
