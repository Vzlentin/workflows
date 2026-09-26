"""A stand-in `herdr`: records its calls, and runs each agent prompt as one fake Pi turn."""

import json
import os
import subprocess
import sys
from pathlib import Path

FAKE_PI = Path(__file__).with_name("fake_pi.py")


def main() -> None:
    args = sys.argv[1:]
    path = Path(os.environ["FAKE_HERDR_STATE"])
    state = json.loads(path.read_text()) if path.exists() else {"calls": [], "agents": {}}
    state["calls"].append(args)
    result = {}
    if args[:2] == ["pane", "split"]:
        result = {"pane": {"pane_id": f"w1:p{len(state['calls']) + 1}"}}
    elif args[:2] == ["agent", "start"]:
        state["agents"][args[2]] = {"args": args[args.index("--") + 1 :], "session": None}
    elif args[:2] == ["agent", "prompt"]:
        agent = state["agents"][args[2]]
        resume = ["--session", agent["session"]] if agent["session"] else []
        turn = subprocess.run(
            [sys.executable, FAKE_PI, *agent["args"], *resume],
            input=args[3], capture_output=True, text=True, check=True,
        )  # fmt: skip
        agent["session"] = json.loads(turn.stdout.splitlines()[0])["id"]
    path.write_text(json.dumps(state))
    print(json.dumps({"result": result}))


if __name__ == "__main__":
    main()
