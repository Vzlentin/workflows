"""The judge: a fixed rubric that decides whether one shipped commit deserves a merge."""

import re
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from workflows import workspace
from workflows.pi import READ_ONLY, Agent, Pi
from workflows.prompts import load, render

JUDGE = Agent("cursor/claude-opus-5-5", "high", (*READ_ONLY, "bash"))
ANSWER = re.compile(r"([1-8])[.):]?\s+(PASS|FAIL)\b")


@dataclass(frozen=True)
class Verdict:
    score: float
    findings: list[str]


def judge(pi: Pi, repository: Path, item: str, base: str, head: str) -> Verdict:
    """One session in a detached worktree at `head`, at `pi.cwd`, removed afterwards."""
    workspace.add_worktree(repository, head, pi.cwd)
    try:
        with closing(pi.open(JUDGE, "judge")) as session:
            reply = session.prompt(
                render(load("judge"), {"item": item, "base": base, "head": head})
            )
    finally:
        workspace.remove_worktree(repository, pi.cwd)
    return verdict(reply)


def verdict(reply: str) -> Verdict:
    """Zero when question 1 or 2 fails, else the passing fraction of questions 3 to 8."""
    answers = {n: ("FAIL", f"{n} FAIL no verdict") for n in range(1, 9)}
    for line in reply.splitlines():
        line = line.replace("*", "").replace("`", "").strip().lstrip("-+> ").strip()
        if match := ANSWER.match(line):
            answers[int(match[1])] = (match[2], line)
    passed = {n for n, (answer, _) in answers.items() if answer == "PASS"}
    score = len(passed & set(range(3, 9))) / 6 if {1, 2} <= passed else 0.0
    return Verdict(score, [line for answer, line in answers.values() if answer == "FAIL"])
