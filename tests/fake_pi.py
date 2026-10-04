"""A stand-in `pi --mode json`: answers plain text by session label and turn, logs its calls.

Turns are counted per session folder. Implement turns append a line to `source.txt`, unless their
round matches `FAKE_PI_BLOCK_ROUND`, when they reply without editing. With `FAKE_PI_SELF_COMMIT=1`,
they commit their changes. Only the second review session under a sessions folder says SHIP. A
split session answers `ITEMS` in a fenced json block,
or `[]` with `FAKE_PI_SPLIT_EMPTY=1`. A reflect session proposes `PLAN` as new instructions; with
`FAKE_PI_REFLECT_FAIL=1` it exits 1 and prints
`reflection failed`, but no messages. The judge passes every question when an earlier session
under its sessions folder was sent `PLAN`, else fails question 3; with `FAKE_PI_JUDGE_FAIL=1` its
reply misses answers 6 to 8, and with `FAKE_PI_JUDGE_ZERO=1` it fails question 1.
"""

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

JUDGE = ["1 PASS", "2 PASS", "- **3 FAIL** `source.txt:1` not needed", "4 PASS", "5 PASS"]
PLAN = "Plan this change in three bullets."
ITEMS = ["# Item one\n\nWrite source.txt.", "# Item two\n\nExtend source.txt."]


def session_directory(args: list[str]) -> Path:
    return Path(args[args.index("--session-dir") + 1])


def judge(directory: Path, calls: list[dict]) -> str:
    if os.environ.get("FAKE_PI_JUDGE_FAIL") == "1":
        return "\n".join(["Checked.", *JUDGE])
    if os.environ.get("FAKE_PI_JUDGE_ZERO") == "1":
        return "\n".join(["Checked.", "1 FAIL incomplete", *(f"{n} PASS" for n in range(2, 9))])
    rollout = [call for call in calls if session_directory(call["args"]).parent == directory.parent]
    if any(PLAN in call["prompt"] for call in rollout):
        return "\n".join(["Checked.", *(f"{n} PASS" for n in range(1, 9))])
    return "\n".join(["Checked.", *JUDGE, "6 PASS", "7 PASS", "8 PASS"])


def reply(directory: Path, calls: list[dict]) -> str:
    label, count = directory.name.rsplit("-", 1)
    turn = sum(session_directory(call["args"]) == directory for call in calls)
    if label == "implement":
        if os.environ.get("FAKE_PI_BLOCK_ROUND") == count:
            return "Cannot proceed without the missing requirements."
        with Path("source.txt").open("a") as source:
            source.write(f"implement {count}\n")
        if os.environ.get("FAKE_PI_SELF_COMMIT") == "1":
            subprocess.run(["git", "add", "source.txt"], check=True)
            subprocess.run(["git", "commit", "-qm", f"implement {count}"], check=True)
        return "Wrote source.txt."
    if label == "judge":
        return judge(directory, calls)
    if label == "split":
        items = [] if os.environ.get("FAKE_PI_SPLIT_EMPTY") == "1" else ITEMS
        return f"Work items:\n```json\n{json.dumps(items)}\n```"
    if label == "reflect":
        return f"New instructions:\n```\n{PLAN}\n```"
    if turn == 1:
        return f"{label} {count} notes"
    if turn == 2:
        return "Keep it.\n**SHIP**" if (label, count) == ("review", "2") else "Change it.\n`FIX`."
    return f"# Handoff\nFix {label} {count}."


def main() -> None:
    args = sys.argv[1:]
    prompt = sys.stdin.read()
    directory = session_directory(args)
    log = Path(os.environ["FAKE_PI_LOG"])
    calls = json.loads(log.read_text()) if log.exists() else []
    calls.append({"session": directory.name, "args": args, "prompt": prompt, "cwd": os.getcwd()})
    log.write_text(json.dumps(calls))
    if directory.name.startswith("reflect-") and os.environ.get("FAKE_PI_REFLECT_FAIL") == "1":
        sys.exit("reflection failed")
    session_id = args[args.index("--session") + 1] if "--session" in args else uuid.uuid4().hex
    message = {
        "role": "assistant",
        "content": [{"type": "text", "text": reply(directory, calls)}],
        "stopReason": "stop",
    }
    with (directory / f"{session_id}.jsonl").open("a") as transcript:
        transcript.write(json.dumps({"type": "message", "message": message}) + "\n")
    print(json.dumps({"type": "session", "version": 3, "id": session_id}))
    print(json.dumps({"type": "message_end", "message": message}))


if __name__ == "__main__":
    main()
