"""Git commands and worktrees."""

import subprocess
from pathlib import Path


def git(cwd: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True, text=True, cwd=cwd, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {result.stdout}{result.stderr}".strip())
    return result.stdout.rstrip("\n")


def repository_root(path: str) -> Path:
    if not Path(path).is_absolute():
        raise ValueError("Repository path must be absolute")
    return Path(git(Path(path), "rev-parse", "--show-toplevel")).resolve()


def resolve_commit(repository: Path, ref: str) -> str:
    return git(repository, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")


def add_worktree(repository: Path, commit: str, path: Path, branch: str | None = None) -> None:
    """A worktree at a commit, on a new branch or detached; the checkout stays untouched."""
    path.parent.mkdir(parents=True, exist_ok=True)
    head = ["-b", branch] if branch else ["--detach"]
    git(repository, "worktree", "add", *head, str(path), commit)


def remove_worktree(repository: Path, path: Path) -> None:
    git(repository, "worktree", "remove", "--force", str(path))
