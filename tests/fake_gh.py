"""An argument-recording `gh pr create` that checks the campaign branch was pushed first."""

import json
import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    args = sys.argv[1:]
    head = args[args.index("--head") + 1]
    remote_head = subprocess.run(
        ["git", "ls-remote", "origin", f"refs/heads/{head}"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()[0]
    local_head = subprocess.run(
        ["git", "rev-parse", f"refs/heads/{head}"], capture_output=True, text=True, check=True
    ).stdout.strip()
    assert remote_head == local_head
    log = Path(os.environ["FAKE_GH_LOG"])
    calls = json.loads(log.read_text()) if log.exists() else []
    calls.append({"args": args, "cwd": os.getcwd(), "head": remote_head})
    log.write_text(json.dumps(calls))
    if os.environ.get("FAKE_GH_FAIL") == "1":
        print("PR creation refused")
        sys.exit("GitHub unavailable")
    print("https://example.test/pull/1")


if __name__ == "__main__":
    main()
