"""The campaign engine: a goal is split into work items, and each is shipped and merged into the
base branch in order.

One read-only session splits the goal at the base; the split is not part of `Ship`, so optimize
leaves its template alone. Git is the only state: running again splits from the updated base.
"""

import sys
from pathlib import Path

import dspy

from workflows import ship, workspace
from workflows.pi import Pi
from workflows.workspace import git


class Split(ship.Turn):
    goal: str = dspy.InputField()
    work_items: list[str] = dspy.OutputField(
        desc="a ```json fenced block with a JSON array of the work items as markdown strings, "
        "or [] when no work is left"
    )


def split(pi: Pi, repository: Path, commit: str, goal: str) -> list[str]:
    """The work items still needed for `goal`, from one session in a detached worktree at `commit`,
    at `pi.cwd`, removed afterwards."""
    workspace.add_worktree(repository, commit, pi.cwd)
    try:
        with ship.Conversation(pi, ship.PLANNER, "split") as session:
            return session(ship.template(Split, "split"), goal=goal).work_items
    finally:
        workspace.remove_worktree(repository, pi.cwd)


def campaign(
    repository: str,
    base: str,
    goal: Path,
    directory: Path,
    rounds: int = 3,
    command: str = "pi",
    herdr: str | None = None,
) -> bool:
    """Whether every work item of `goal` shipped with a judge score above 0 and was merged into
    `base`, in order. The first item that did not keeps its branch and worktree."""
    text = ship.read_item(goal)
    if directory.exists():
        raise ValueError(f"run directory {directory} already exists; a campaign needs a new one")
    root = workspace.repository_root(repository)
    if git(root, "branch", "--list", "--format=%(HEAD)", base) != "*":
        raise ValueError(f"--base {base} is not a branch with a commit checked out in {root}")
    base_ref = f"refs/heads/{base}"
    commit = workspace.resolve_commit(root, base_ref)
    items = split(
        Pi(directory / "sessions", directory / "split", command, herdr), root, commit, text
    )
    if not items:
        print(f"nothing left of {ship.subject(text)}")
        return True
    (directory / "items").mkdir(parents=True, exist_ok=True)
    for n, item in enumerate(items, 1):
        path = directory / "items" / f"{n}.md"
        path.write_text(f"{item.strip()}\n")
        run = directory / f"{directory.name}-{n}"
        if not ship.ship(repository, base_ref, path, run, rounds, command, herdr):
            return False
        name = ship.subject(item)
        branch = f"ship/{run.name}"
        branch_ref = f"refs/heads/{branch}"
        worktree = run / "worktree"
        score = git(root, "log", "-1", "--format=%(trailers:key=Judge,valueonly)", branch_ref)
        if not score or float(score) == 0:
            print(f"not merged {name}: judge {score or 'failed'}: {worktree}")
            return False
        try:
            git(root, "merge", "--ff-only", branch_ref)
        except RuntimeError as error:
            print(f"merge failed on {name}: {error}", file=sys.stderr)
            print(f"not merged {name}: {worktree}")
            return False
        workspace.remove_worktree(root, worktree)
        git(root, "branch", "-d", branch)
        print(f"merged {name} into {base}")
    return True
