"""The campaign engine: accepted work items form one branch and pull request into the base.

One read-only session splits the goal at the base; another writes pull request text at the
accepted tip. Neither is part of `Ship`, so optimize leaves their templates alone. The base
branch, checkout and index stay untouched.
"""

import subprocess
import sys
from pathlib import Path

import dspy

from workflows import judge, ship, workspace
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


class PullRequest(ship.Turn):
    goal: str = dspy.InputField()
    base: str = dspy.InputField()
    head: str = dspy.InputField()
    stop: str = dspy.InputField()
    text: list[str] = dspy.OutputField(
        desc="a ```json fenced block with a JSON array of exactly two non-blank strings: "
        "[title, body], with a single-line title and a markdown body"
    )


def write_pr(pi: Pi, repository: Path, base: str, head: str, goal: str, stop: str) -> list[str]:
    """A title and body from one session in a detached worktree at `head`, removed afterwards.
    Raises RuntimeError with the output when it is not a pair with a single-line title."""
    workspace.add_worktree(repository, head, pi.cwd)
    try:
        with ship.Conversation(pi, judge.JUDGE, "pr") as session:
            text = session(
                ship.template(PullRequest, "pr"), goal=goal, base=base, head=head, stop=stop
            ).text
        if len(text) != 2 or text[0].splitlines() != [text[0]]:
            raise RuntimeError(f"PR reply must be [title, body] with a single-line title: {text!r}")
        return text
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
    gh: str = "gh",
) -> bool:
    """Whether every work item was accepted and published in one pull request into `base`.
    An early stop publishes accepted work as a draft and keeps remaining item branches and worktrees."""
    text = ship.read_item(goal)
    if directory.exists():
        raise ValueError(f"run directory {directory} already exists; a campaign needs a new one")
    root = workspace.repository_root(repository)
    base_ref = f"refs/heads/{base}"
    try:
        git(root, "show-ref", "--verify", base_ref)
        commit = workspace.resolve_commit(root, base_ref)
    except RuntimeError as error:
        raise ValueError(
            f"--base {base} is not a branch with a commit in {root}: {error}"
        ) from error
    branch = f"campaign/{directory.name}"
    branch_ref = f"refs/heads/{branch}"
    git(root, "branch", branch, commit)
    items = split(
        Pi(directory / "sessions", directory / "split", command, herdr), root, commit, text
    )
    if not items:
        print(f"nothing left of {ship.subject(text)}")
        return True
    (directory / "items").mkdir(parents=True, exist_ok=True)
    accepted = []
    stop = None
    try:
        for n, item in enumerate(items, 1):
            name = ship.subject(item)
            path = directory / "items" / f"{n}.md"
            path.write_text(f"{item.strip()}\n")
            run = directory / f"{directory.name}-{n}"
            result = ship.ship(repository, branch_ref, path, run, rounds, command, herdr)
            if result.status != "shipped":
                reason = f"{result.status} after {result.rounds} rounds"
                if result.status == "blocked":
                    reason += f": {result.reply}"
                stop = (name, reason)
                break
            worktree = run / "worktree"
            score = git(root, "log", "-1", "--format=%(trailers:key=Judge,valueonly)", result.head)
            if not score or float(score) == 0:
                reason = f"judge {score or 'failed'}"
                print(f"not accepted {name}: {reason}: {worktree}")
                stop = (name, reason)
                break
            git(root, "merge-base", "--is-ancestor", commit, result.head)
            git(root, "update-ref", branch_ref, result.head, commit)
            commit = result.head
            accepted.append(name)
            workspace.remove_worktree(root, worktree)
            git(root, "branch", "-D", f"ship/{run.name}")
            print(f"accepted {name} into {branch}")
    except (RuntimeError, OSError) as error:
        print(f"campaign failed on {name}: {error}", file=sys.stderr)
        stop = (name, str(error))
    if not accepted:
        return False
    title = ship.subject(text)
    body = f"{text.strip()}\n\nAccepted work items:\n" + "\n".join(f"- {name}" for name in accepted)
    stopped = "No early stop."
    if stop:
        name, reason = stop
        stopped = f"Stopped at {name}: {reason}"
        body += f"\n\n{stopped}"
    try:
        git(root, "push", "origin", f"{branch_ref}:{branch_ref}")
        try:
            title, body = write_pr(
                Pi(directory / "sessions", directory / "pr", command, herdr),
                root, base_ref, commit, text, stopped,
            )  # fmt: skip
        except Exception as error:  # noqa: BLE001 - publication can use the goal text
            print(f"PR text failed for {branch}: {error}; using goal text", file=sys.stderr)
        args = [gh, "pr", "create", "--base", base, "--head", branch, "--title", title]
        if stop:
            args.append("--draft")
        args += ["--body", body]
        publication = subprocess.run(args, cwd=root, capture_output=True, text=True, check=False)
        if publication.returncode != 0:
            raise RuntimeError(f"{gh} pr create failed: {publication.stdout}{publication.stderr}")
    except (RuntimeError, OSError) as error:
        print(f"publication failed for {branch}: {error}", file=sys.stderr)
        return False
    print(publication.stdout.strip())
    return stop is None
