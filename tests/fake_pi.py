"""A stand-in `pi --mode json`: answers plain text by session label and turn, logs its calls.

Implement turns write `source.txt`. Only the second review session says SHIP.
"""

import json
import os
import sys
import uuid
from pathlib import Path

JUDGE = ["1 PASS", "2 PASS", "- **3 FAIL** `source.txt:1` not needed", "4 PASS", "5 PASS"]


def reply(label: str, count: int, turn: int) -> str:
    if label == "implement":
        Path("source.txt").write_text(f"implement {count}\n")
        return "Wrote source.txt."
    if label == "judge":
        return "\n".join(["Checked.", *JUDGE, "6 PASS", "7 PASS", "8 PASS"])
    if turn == 1:
        return f"{label} {count} notes"
    if turn == 2:
        return "Keep it.\n**SHIP**" if (label, count) == ("review", 2) else "Change it.\n`FIX`."
    return f"# Handoff\nFix {label} {count}."


def main() -> None:
    args = sys.argv[1:]
    prompt = sys.stdin.read()
    directory = Path(args[args.index("--session-dir") + 1])
    log = Path(os.environ["FAKE_PI_LOG"])
    calls = json.loads(log.read_text()) if log.exists() else []
    calls.append({"session": directory.name, "args": args, "prompt": prompt, "cwd": os.getcwd()})
    log.write_text(json.dumps(calls))
    label, count = directory.name.rsplit("-", 1)
    turn = sum(call["session"] == directory.name for call in calls)
    session_id = args[args.index("--session") + 1] if "--session" in args else uuid.uuid4().hex
    message = {
        "role": "assistant",
        "content": [{"type": "text", "text": reply(label, int(count), turn)}],
        "stopReason": "stop",
    }
    with (directory / f"{session_id}.jsonl").open("a") as transcript:
        transcript.write(json.dumps({"type": "message", "message": message}) + "\n")
    print(json.dumps({"type": "session", "version": 3, "id": session_id}))
    print(json.dumps({"type": "message_end", "message": message}))


if __name__ == "__main__":
    main()
