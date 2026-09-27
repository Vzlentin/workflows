import json
import os
import subprocess
import sys
from pathlib import Path

import dspy
import pytest

from workflows import ship
from workflows.cli import main
from workflows.judge import verdict
from workflows.pi import Pi
from workflows.prompts import DIRECTORY, Template, load, render

FAKE_PI = Path(__file__).with_name("fake_pi.py")
FAKE_HERDR = Path(__file__).with_name("fake_herdr.py")


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture
def repository(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    for role in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{role}_NAME", "t")
        monkeypatch.setenv(f"GIT_{role}_EMAIL", "t@t")
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "README.md").write_text("hello\n")
    git(repo, "add", ".")
    git(repo, "commit", "-qm", "init")
    return repo


@pytest.fixture
def pi(tmp_path, monkeypatch):
    script = tmp_path / "pi"
    script.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_PI} "$@"\n')
    script.chmod(0o755)
    monkeypatch.setenv("FAKE_PI_LOG", str(tmp_path / "calls.json"))
    monkeypatch.delenv("HERDR_ENV", raising=False)
    return script


@pytest.fixture
def items(tmp_path):
    paths = [tmp_path / "one.md", tmp_path / "two.md"]
    paths[0].write_text("# Item one\n\nWrite source.txt.\n")
    paths[1].write_text("# Item two\n\nRewrite source.txt.\n")
    return paths


def calls():
    return json.loads(Path(os.environ["FAKE_PI_LOG"]).read_text())


def test_template_appends_inputs_and_parses_the_verdict_line():
    for path in DIRECTORY.glob("*.md"):
        assert path.read_text().rstrip().endswith("$@") and "$@" not in load(path.stem)
    assert render("Do it.", {"item": "x", "plan": ""}) == "Do it.\n\n## item\nx"
    signature = ship.Challenge.with_instructions("Challenge.")
    history = dspy.History(messages=[{"item": "x", "text": "plan notes"}])
    [message] = Template().format(signature, [], {"history": history})
    assert message["content"] == (
        "Challenge.\n\nEnd with one line: SHIP if nothing needs to change, FIX otherwise."
    )
    assert Template().parse(signature, "Keep it.\n**SHIP**.")["verdict"] == "SHIP"
    assert Template().parse(signature, "Keep it all.") == {"text": "Keep it all."}


def test_judge_scores_gates_and_quality_questions():
    passing = [f"{n} PASS" for n in range(1, 9)]
    assert verdict("\n".join(passing)).score == 1.0
    gate = verdict("\n".join(["1 PASS", "2 FAIL a.py:3 breaks", *passing[2:]]))
    assert gate.score == 0.0 and gate.findings == ["2 FAIL a.py:3 breaks"]
    quality = verdict("\n".join([*passing[:4], "- **5 FAIL** `a.py:1` one adapter", *passing[5:7]]))
    assert quality.score == 4 / 6
    assert quality.findings == ["5 FAIL a.py:1 one adapter", "8 FAIL no verdict"]


def test_each_turn_is_traced_with_the_earlier_turns_of_its_session(repository, pi, tmp_path):
    program = ship.Ship(rounds=1)
    with dspy.context(trace=[]):
        result = program(pi=Pi(tmp_path / "sessions", repository, str(pi)), item="# Item\n")
        trace = dspy.settings.trace

    assert result.status == "stopped" and result.head == git(repository, "rev-parse", "HEAD")
    names = {id(predictor): name for name, predictor in program.named_predictors()}
    assert [names[id(predictor)] for predictor, _, _ in trace] == [
        "plan", "challenge", "handoff", "implement", "review", "challenge", "handoff",
    ]  # fmt: skip
    histories = [inputs["history"].messages for _, inputs, _ in trace]
    assert [len(history) for history in histories] == [0, 1, 2, 0, 0, 1, 2]
    assert histories[5][0]["text"] == "review 1 notes"
    assert histories[6][1]["verdict"] == "FIX"


def test_ship_commits_shipped_items_and_stops_at_the_first_that_does_not_ship(
    repository, pi, items, tmp_path, capsys, monkeypatch
):
    # Inside Herdr the CLI would open panes; --headless keeps `pi --mode json`.
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setenv("HERDR_PANE_ID", "w1:p1")
    run_dir = tmp_path / "run"
    code = main(
        ["ship", "--headless", "--pi", str(pi), "--repo", str(repository), "--rounds", "2",
         "--run-dir", str(run_dir), *map(str, items)]
    )  # fmt: skip

    assert code == 1
    worktree = run_dir / "worktree"
    subjects = git(repository, "log", "--format=%s", "main..ship/run").splitlines()
    assert subjects == ["round 2", "round 1", "Item one"]
    item = git(repository, "rev-parse", "ship/run~2")
    body = git(repository, "log", "-1", "--format=%B", item)
    assert "3 FAIL source.txt:1 not needed" in body
    trailers = git(repository, "log", "-1", "--format=%(trailers:only)", item)
    assert trailers.splitlines() == ["Rounds: 2", "Judge: 0.83"]
    assert git(repository, "show", f"{item}:source.txt") == "implement 2"
    assert (worktree / "source.txt").read_text() == "implement 4\n"
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith(f"shipped {items[0]} in 2 rounds, judge 0.83, ")
    assert out[1] == f"stopped at {items[1]} after 2 rounds: {worktree}"

    sessions = [call["session"] for call in calls()]
    assert sessions == [
        "plan-1", "plan-1", "plan-1", "implement-1", "review-1", "review-1", "review-1",
        "implement-2", "review-2", "review-2", "judge-1",
        "plan-2", "plan-2", "plan-2", "implement-3", "review-3", "review-3", "review-3",
        "implement-4", "review-4", "review-4", "review-4",
    ]  # fmt: skip
    for index, call in enumerate(calls()):
        resumed = index > 0 and sessions[index - 1] == call["session"]
        assert ("--session" in call["args"]) == resumed
        assert "JSON" not in call["prompt"]
    assert calls()[10]["cwd"] == str(run_dir / "judge")
    assert not (run_dir / "judge").exists()
    assert "Item one" in calls()[0]["prompt"] and calls()[2]["prompt"].startswith("Write a handoff")
    assert "Fix plan 1." in calls()[3]["prompt"]
    review = calls()[8]["prompt"]
    assert str(run_dir / "sessions" / "round-2-fix.patch") in review
    assert "Fix review 1." in review


def test_ship_in_herdr_runs_each_session_in_one_pane_and_closes_it(
    repository, pi, items, tmp_path, monkeypatch
):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    herdr = bin_dir / "herdr"
    herdr.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_HERDR} "$@"\n')
    herdr.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_HERDR_STATE", str(tmp_path / "herdr.json"))
    shipped = ship.ship(
        str(repository), "main", items[:1], tmp_path / "run", command=str(pi), herdr="w1:p1"
    )

    assert shipped
    herdr_calls = json.loads((tmp_path / "herdr.json").read_text())["calls"]
    splits = [call for call in herdr_calls if call[:2] == ["pane", "split"]]
    starts = [call for call in herdr_calls if call[:2] == ["agent", "start"]]
    prompts = [call[2] for call in herdr_calls if call[:2] == ["agent", "prompt"]]
    closes = [call for call in herdr_calls if call[:2] == ["pane", "close"]]
    assert all(call[call.index("--pane") + 1] == "w1:p1" for call in splits)
    sessions = [Path(call[call.index("--session-dir") + 1]).name for call in starts]
    assert sessions == [
        "plan-1", "plan-1", "implement-1", "review-1", "implement-2", "review-2", "judge-1",
    ]  # fmt: skip
    assert starts[0] == starts[1]
    names = [call[2] for call in starts[1:]]
    assert [prompts.count(name) for name in names] == [3, 1, 3, 1, 2, 1]
    assert len(splits) == len(closes) == 6
    assert [call[call.index("--pane") + 1] for call in starts[1:]] == [call[2] for call in closes]
