"""The ship engine: a work item is planned, then implemented and reviewed for a few rounds.

Every box is one fresh Pi session; its turns are the predictors below, whose instructions are the
templates in `prompts/`. Git is the only state: a shipped item is one squashed commit.
"""

import os
import sys
import time
import uuid
from pathlib import Path
from typing import Literal

import dspy

from workflows import prompts, workspace
from workflows.judge import Verdict, judge
from workflows.pi import READ_ONLY, Agent, Pi, SessionLM
from workflows.workspace import git

PLANNER = Agent("openai-codex/gpt-6-astra", "xhigh", READ_ONLY)
IMPLEMENTER = Agent("openai-codex/gpt-6.1-sol", "xhigh", (*READ_ONLY, "bash", "edit", "write"))


class Turn(dspy.Signature):
    history: dspy.History = dspy.InputField()


class Plan(Turn):
    item: str = dspy.InputField()
    text: str = dspy.OutputField()


class Challenge(Turn):
    text: str = dspy.OutputField()
    verdict: Literal["SHIP", "FIX"] = dspy.OutputField(
        desc="SHIP if nothing needs to change, FIX otherwise"
    )


class Handoff(Turn):
    text: str = dspy.OutputField()


class Implement(Turn):
    plan: str = dspy.InputField()
    text: str = dspy.OutputField()


class Review(Turn):
    item: str = dspy.InputField()
    plan: str = dspy.InputField()
    change: str = dspy.InputField()
    reply: str = dspy.InputField()
    text: str = dspy.OutputField()


def template(signature: type[dspy.Signature], name: str) -> dspy.Predict:
    return dspy.Predict(signature.with_instructions(prompts.load(name)))


class Conversation:
    """One Pi session, closed on exit. Each predictor call is its next turn, and gets the turns
    before it as `history`, so a trace records everything the turn saw."""

    def __init__(self, pi: Pi, agent: Agent, label: str):
        self.session = pi.open(agent, label)
        self.lm = SessionLM(self.session)
        self.turns: list[dict] = []

    def __enter__(self) -> "Conversation":
        return self

    def __exit__(self, *_) -> None:
        self.session.close()

    def __call__(self, predictor: dspy.Predict, **inputs: str) -> dspy.Prediction:
        with dspy.context(lm=self.lm, adapter=prompts.Template()):
            prediction = predictor(history=dspy.History(messages=list(self.turns)), **inputs)
        self.turns.append({**inputs, **prediction.toDict()})
        return prediction


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
        """Commits changed rounds in `pi.cwd`; an empty round blocks with the implementer's reply.
        A shipped item is squashed into one commit, `head`."""
        start = git(pi.cwd, "rev-parse", "HEAD")
        with Conversation(pi, PLANNER, "plan") as session:
            session(self.plan, item=item)
            session(self.challenge)
            plan = session(self.handoff).text
        for n in range(1, self.rounds + 1):
            before = git(pi.cwd, "rev-parse", "HEAD")
            with Conversation(pi, IMPLEMENTER, "implement") as session:
                reply = session(self.implement, plan=plan).text
            git(pi.cwd, "add", "-A")
            if not git(pi.cwd, "diff", "--cached", "--name-only"):
                return dspy.Prediction(
                    status="blocked", rounds=n, head=git(pi.cwd, "rev-parse", "HEAD"), reply=reply
                )
            git(pi.cwd, "commit", "-m", f"round {n}")
            change = [patch(pi, f"round-{n}.patch", start)]
            if n > 1:
                change.append(patch(pi, f"round-{n}-fix.patch", before))
            with Conversation(pi, PLANNER, "review") as session:
                session(self.review, item=item, plan=plan, change="\n".join(change), reply=reply)
                if session(self.challenge).verdict == "SHIP":
                    head = workspace.squash(pi.cwd, start, message(item, n))
                    return dspy.Prediction(status="shipped", rounds=n, head=head)
                plan = session(self.handoff).text
        head = git(pi.cwd, "rev-parse", "HEAD")
        return dspy.Prediction(status="stopped", rounds=self.rounds, head=head)


def patch(pi: Pi, name: str, base: str) -> str:
    path = pi.directory / name
    path.write_text(git(pi.cwd, "diff", "--binary", base, "HEAD") + "\n")
    return str(path)


def subject(item: str) -> str:
    """The first non-empty line of `item`, without leading #."""
    return next(line for line in item.splitlines() if line.strip()).lstrip("#").strip()


def message(item: str, rounds: int, verdict: Verdict | None = None) -> str:
    paragraphs = [subject(item), item.strip()]
    trailers = [f"Rounds: {rounds}"]
    if verdict:
        paragraphs += ["\n".join(verdict.findings)] if verdict.findings else []
        trailers.append(f"Judge: {verdict.score:.2f}")
    return "\n\n".join([*paragraphs, "\n".join(trailers)])


def read_item(path: Path) -> str:
    """The text of the work item at `path`; raises ValueError when it has no non-empty line."""
    text = path.read_text()
    if not text.strip():
        raise ValueError(f"work item {path} has no non-empty line")
    return text


def run_directory() -> Path:
    home = os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state"
    stamp = time.strftime("%Y%m%dT%H%M%S")
    return Path(home) / "workflows" / "runs" / f"{stamp}-{uuid.uuid4().hex[:8]}"


def ship(
    repository: str,
    base: str,
    item: Path,
    directory: Path,
    rounds: int = 3,
    command: str = "pi",
    herdr: str | None = None,
) -> bool:
    """Whether the item shipped onto `ship/<run>`; stopped or blocked items keep round commits."""
    text = read_item(item)
    name = subject(text)
    root = workspace.repository_root(repository)
    commit = workspace.resolve_commit(root, base)
    worktree = directory / "worktree"
    workspace.add_worktree(root, commit, worktree, branch=f"ship/{directory.name}")
    result = Ship(rounds)(pi=Pi(directory / "sessions", worktree, command, herdr), item=text)
    if result.status in ("stopped", "blocked"):
        print(f"{result.status} {name} after {result.rounds} rounds: {worktree}")
        if result.status == "blocked":
            print(result.reply)
        return False
    judge_pi = Pi(directory / "sessions", directory / "judge", command, herdr)
    try:
        verdict = judge(judge_pi, root, text, commit, result.head)
    except Exception as error:  # noqa: BLE001 - the commit stands without a score
        print(f"judge failed on {name}: {error}", file=sys.stderr)
        score = "failed"
    else:
        git(worktree, "commit", "--amend", "-m", message(text, result.rounds, verdict))
        score = f"{verdict.score:.2f}"
    sha = git(worktree, "rev-parse", "--short", "HEAD")
    print(f"shipped {name} in {result.rounds} rounds, judge {score}, {sha}")
    return True
