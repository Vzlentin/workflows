"""A stand-in `pi --mode json`: answers by stage, does the implement work, logs its calls."""

import json
import os
import sys
import uuid
from pathlib import Path

REVIEW = {"completeness": True, "correctness": True, "maintainability": True, "findings": "ok"}
REJECT = {**REVIEW, "correctness": False, "findings": "Fix the edge case."}
PLAN = {
    "plan": {
        "plan": "Write finished into source.txt",
        "criteria": ["source.txt says finished"],
        "commands": ['test "$(cat source.txt)" = finished'],
        "blocker": "",
    }
}
REPORT = {"report": {"summary": "Did the work", "notes": ["note"], "blocker": ""}}


def main() -> None:
    args = sys.argv[1:]
    prompt = sys.stdin.read()
    directory = Path(args[args.index("--session-dir") + 1])
    log = Path(os.environ["FAKE_PI_LOG"])
    calls = json.loads(log.read_text()) if log.exists() else []
    kind = directory.name.rsplit("-", 1)[0]
    calls.append({"kind": kind, "args": args, "prompt": prompt, "cwd": os.getcwd()})
    log.write_text(json.dumps(calls))
    reviews = sum(1 for call in calls if call["kind"] == "review")
    if kind == "plan" and "--session" not in args:
        text = "I forgot the JSON."
    elif kind == "plan":
        text = json.dumps(PLAN)
    elif kind in ("implement", "fix"):
        Path("source.txt").write_text("finished" if kind == "fix" else "draft")
        text = json.dumps(REPORT)
    elif kind == "review":
        text = json.dumps({"review": REJECT if reviews == 1 else REVIEW})
    else:
        text = json.dumps({"review": REVIEW})
    session_id = args[args.index("--session") + 1] if "--session" in args else uuid.uuid4().hex
    (directory / f"{session_id}.jsonl").touch()
    print(json.dumps({"type": "session", "version": 3, "id": session_id}))
    message = {
        "role": "assistant",
        "content": [{"type": "text", "text": text}],
        "stopReason": "stop",
    }
    print(json.dumps({"type": "message_end", "message": message}))


if __name__ == "__main__":
    main()
