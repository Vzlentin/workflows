"""Git worktrees, working-tree snapshots, and check commands."""

import hashlib
import subprocess
from dataclasses import dataclass
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


def add_worktree(repository: Path, commit: str, path: Path) -> None:
    """A detached worktree at the committed base; the checkout's own changes stay untouched."""
    path.parent.mkdir(parents=True, exist_ok=True)
    git(repository, "worktree", "add", "--detach", str(path), commit)


def remove_worktree(repository: Path, path: Path) -> None:
    git(repository, "worktree", "remove", "--force", str(path))


@dataclass(frozen=True)
class Snapshot:
    fingerprint: str
    diff: str


def snapshot(worktree: Path, base: str) -> Snapshot:
    """Content fingerprint of tracked and untracked files, and the complete diff against base."""
    names = sorted(set(git(worktree, "ls-files", "-co", "--exclude-standard", "-z").split("\0")))
    untracked = set(git(worktree, "ls-files", "-o", "--exclude-standard", "-z").split("\0"))
    digest = hashlib.sha256()
    diff = git(worktree, "diff", "--binary", "--no-ext-diff", base, "--")
    for name in names:
        if not name:
            continue
        path = worktree / name
        digest.update(name.encode())
        if path.is_dir():
            digest.update(b"directory")
            continue
        if path.is_symlink():
            content = str(path.readlink()).encode()
        elif path.exists():
            content = path.read_bytes()
        else:
            content = b"deleted"
        digest.update(str(path.lstat().st_mode).encode() if path.exists() else b"")
        digest.update(content)
        if name in untracked:
            diff += f'\nUntracked file "{name}":\n{content.decode("utf8", "replace")}\n'
    return Snapshot(digest.hexdigest(), diff)


def run_check(command: str, cwd: Path, output: Path) -> int:
    """Run one shell command; its complete output goes to `output`."""
    with output.open("wb") as file:
        result = subprocess.run(
            ["/bin/sh", "-c", command], cwd=cwd, stdout=file, stderr=subprocess.STDOUT, check=False
        )
    return result.returncode
