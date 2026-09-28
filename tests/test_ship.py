import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import dspy
import pytest

from workflows import campaign, ship
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
def item(tmp_path):
    path = tmp_path / "one.md"
    path.write_text("# Item one\n\nWrite source.txt.\n")
    return path


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

    split = campaign.Split.with_instructions("Split.")
    [message] = Template().format(split, [], {"history": history, "goal": "Reach it."})
    assert message["content"] == (
        "Split.\n\n## goal\nReach it.\n\nEnd with a ```json fenced block with a JSON array of the"
        " work items as markdown strings, or [] when no work is left."
    )
    reply = (
        'Old:\n```json\n["# Old"]\n```\nNew:\n```json\n["# One\\n```sh\\nx\\n```", "# Two"]\n```\n'
    )
    assert Template().parse(split, reply) == {"work_items": ["# One\n```sh\nx\n```", "# Two"]}
    assert Template().parse(split, "Nothing left.\n```json\n[]\n```") == {"work_items": []}
    for invalid in (
        "No block.",
        '```json\n["# One"\n```',
        '```json\n{"items": ["# One"]}\n```',
        '```json\n["# One", 2]\n```',
        '```json\n["# One", " \\n"]\n```',
        '```json\n["# One"]\n```\n```json\n["# Two",]\n```',
        '```json\n[]\n```\n```json\n["# One"]',
    ):
        with pytest.raises(RuntimeError, match=re.escape(invalid)):
            Template().parse(split, invalid)


def test_judge_scores_gates_and_quality_questions():
    passing = [f"{n} PASS" for n in range(1, 9)]
    assert verdict("\n".join(passing)).score == 1.0
    gate = verdict("\n".join(["1 PASS", "2 FAIL a.py:3 breaks", *passing[2:]]))
    assert gate.score == 0.0 and gate.findings == ["2 FAIL a.py:3 breaks"]
    quality = verdict("\n".join([*passing[:4], "- **5 FAIL** `a.py:1` one adapter", *passing[5:]]))
    assert quality.score == 5 / 6
    assert quality.findings == ["5 FAIL a.py:1 one adapter"]
    with pytest.raises(RuntimeError):
        verdict("\n".join(passing[:7]))


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


def test_ship_commits_a_shipped_item_and_keeps_the_rounds_of_one_that_does_not_ship(
    repository, pi, item, tmp_path, capsys, monkeypatch
):
    # Inside Herdr the CLI would open panes; --headless keeps `pi --mode json`.
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setenv("HERDR_PANE_ID", "w1:p1")

    def run(name: str, rounds: int) -> int:
        return main(
            ["ship", "--headless", "--pi", str(pi), "--repo", str(repository), "--rounds",
             str(rounds), "--run-dir", str(tmp_path / name), str(item)]
        )  # fmt: skip

    assert run("run", 2) == 0
    run_dir = tmp_path / "run"
    assert git(repository, "log", "--format=%s", "main..ship/run") == "Item one"
    body = git(repository, "log", "-1", "--format=%B", "ship/run")
    assert "3 FAIL source.txt:1 not needed" in body
    trailers = git(repository, "log", "-1", "--format=%(trailers:only)", "ship/run")
    assert trailers.splitlines() == ["Rounds: 2", "Judge: 0.83"]
    assert git(repository, "show", "ship/run:source.txt") == "implement 1\nimplement 2"
    sha = git(repository, "rev-parse", "--short", "ship/run")
    assert capsys.readouterr().out == f"shipped Item one in 2 rounds, judge 0.83, {sha}\n"

    sessions = [call["session"] for call in calls()]
    assert sessions == [
        "plan-1", "plan-1", "plan-1", "implement-1", "review-1", "review-1", "review-1",
        "implement-2", "review-2", "review-2", "judge-1",
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

    assert run("stopped", 1) == 1
    worktree = tmp_path / "stopped" / "worktree"
    assert git(repository, "log", "--format=%s", "main..ship/stopped") == "round 1"
    assert (worktree / "source.txt").read_text() == "implement 1\n"
    assert capsys.readouterr().out == f"stopped Item one after 1 rounds: {worktree}\n"


def test_ship_rejects_an_empty_item_before_the_run_starts(repository, pi, tmp_path):
    empty = tmp_path / "empty.md"
    empty.write_text("\n  \n")
    with pytest.raises(ValueError, match=re.escape(str(empty))):
        ship.ship(str(repository), "main", empty, tmp_path / "run", command=str(pi))

    assert git(repository, "branch", "--list", "ship/*") == ""
    assert not Path(os.environ["FAKE_PI_LOG"]).exists()


def run_campaign(pi: Path, repository: Path, run_dir: Path, goal: Path, *options: str) -> int:
    return main(
        ["campaign", "--pi", str(pi), "--repo", str(repository), "--run-dir", str(run_dir),
         *options, str(goal)]
    )  # fmt: skip


def kept(repository: Path, run_dir: Path, head: str) -> tuple[Path, str]:
    worktree = run_dir / f"{run_dir.name}-1" / "worktree"
    assert worktree.is_dir() and git(repository, "rev-parse", "refs/heads/main") == head
    assert not (run_dir / "items" / "2.md").exists()
    return worktree, git(repository, "rev-parse", "--short", f"ship/{run_dir.name}-1")


def test_campaign_merges_each_split_item_into_the_base_and_stops_at_the_first_it_cannot_merge(
    repository, pi, tmp_path, capsys, monkeypatch
):
    goal = tmp_path / "goal.md"
    goal.write_text("\n  \n")
    with pytest.raises(ValueError, match=re.escape(str(goal))):
        run_campaign(pi, repository, tmp_path / "empty-goal", goal)
    goal.write_text("# Goal\n\nWrite two items.\n")
    git(repository, "branch", "topic")
    with pytest.raises(ValueError, match="--base topic is not a branch with a commit"):
        run_campaign(pi, repository, tmp_path / "wrong-branch", goal, "--base", "topic")
    git(repository, "symbolic-ref", "HEAD", "refs/heads/unborn")
    with pytest.raises(ValueError, match="--base unborn is not a branch with a commit"):
        run_campaign(pi, repository, tmp_path / "unborn", goal, "--base", "unborn")
    git(repository, "symbolic-ref", "HEAD", "refs/heads/main")
    assert not Path(os.environ["FAKE_PI_LOG"]).exists()
    assert len(git(repository, "worktree", "list").splitlines()) == 1

    decoy = git(repository, "commit-tree", "HEAD^{tree}", "-m", "decoy")
    tags = ("main", "ship/run-1", "ship/run-2")
    for tag in tags:
        git(repository, "tag", tag, decoy)
    run_dir = tmp_path / "run"
    assert run_campaign(pi, repository, run_dir, goal) == 0
    assert git(repository, "log", "--format=%s", "refs/heads/main") == "Item two\nItem one\ninit"
    assert [git(repository, "rev-parse", f"refs/tags/{tag}") for tag in tags] == [decoy] * 3
    for commit in ("refs/heads/main~1", "refs/heads/main"):
        trailers = git(repository, "log", "-1", "--format=%(trailers:only)", commit)
        assert trailers.splitlines() == ["Rounds: 2", "Judge: 0.83"]
        assert git(repository, "show", "--format=", "--numstat", commit) == "2\t0\tsource.txt"
    assert (repository / "source.txt").read_text() == "implement 1\nimplement 2\n" * 2
    assert (run_dir / "items" / "1.md").read_text() == "# Item one\n\nWrite source.txt.\n"
    assert (run_dir / "items" / "2.md").read_text() == "# Item two\n\nExtend source.txt.\n"
    shipped = [
        "plan-1", "plan-1", "plan-1", "implement-1", "review-1", "review-1", "review-1",
        "implement-2", "review-2", "review-2", "judge-1",
    ]  # fmt: skip
    assert [call["session"] for call in calls()] == ["split-1", *shipped, *shipped]
    assert calls()[0]["cwd"] == str(run_dir / "split")
    assert "## goal\n# Goal\n\nWrite two items." in calls()[0]["prompt"]
    assert calls()[0]["prompt"].endswith("or [] when no work is left.")
    assert "## item\n# Item one\n\nWrite source.txt." in calls()[1]["prompt"]
    assert "## item\n# Item two\n\nExtend source.txt." in calls()[12]["prompt"]
    assert list((run_dir / "sessions" / "split-1").glob("*.jsonl"))
    assert not (run_dir / "split").exists()
    assert git(repository, "branch", "--list", "ship/*") == ""
    assert len(git(repository, "worktree", "list").splitlines()) == 1
    one, two = (
        git(repository, "rev-parse", "--short", commit)
        for commit in ("refs/heads/main~1", "refs/heads/main")
    )
    assert capsys.readouterr().out == (
        f"shipped Item one in 2 rounds, judge 0.83, {one}\nmerged Item one into main\n"
        f"shipped Item two in 2 rounds, judge 0.83, {two}\nmerged Item two into main\n"
    )

    head = git(repository, "rev-parse", "refs/heads/main")
    monkeypatch.setenv("FAKE_PI_JUDGE_ZERO", "1")
    assert run_campaign(pi, repository, tmp_path / "zero", goal) == 1
    worktree, sha = kept(repository, tmp_path / "zero", head)
    assert capsys.readouterr().out == (
        f"shipped Item one in 2 rounds, judge 0.00, {sha}\n"
        f"not merged Item one: judge 0.00: {worktree}\n"
    )
    monkeypatch.delenv("FAKE_PI_JUDGE_ZERO")
    earlier = len(calls())
    with pytest.raises(ValueError, match="run directory .*zero already exists"):
        run_campaign(pi, repository, tmp_path / "zero", goal)
    assert len(calls()) == earlier
    monkeypatch.setenv("FAKE_PI_JUDGE_FAIL", "1")
    assert run_campaign(pi, repository, tmp_path / "unjudged", goal) == 1
    worktree, sha = kept(repository, tmp_path / "unjudged", head)
    assert capsys.readouterr().out == (
        f"shipped Item one in 2 rounds, judge failed, {sha}\n"
        f"not merged Item one: judge failed: {worktree}\n"
    )
    monkeypatch.delenv("FAKE_PI_JUDGE_FAIL")
    assert run_campaign(pi, repository, tmp_path / "stopped", goal, "--rounds", "1") == 1
    worktree, _ = kept(repository, tmp_path / "stopped", head)
    assert git(repository, "log", "--format=%s", "refs/heads/main..ship/stopped-1") == "round 1"
    assert capsys.readouterr().out == f"stopped Item one after 1 rounds: {worktree}\n"

    (repository / "source.txt").write_text("local edit\n")
    assert run_campaign(pi, repository, tmp_path / "conflict", goal) == 1
    worktree, sha = kept(repository, tmp_path / "conflict", head)
    out, err = capsys.readouterr()
    assert out == (
        f"shipped Item one in 2 rounds, judge 0.83, {sha}\nnot merged Item one: {worktree}\n"
    )
    assert "merge failed on Item one: git merge failed:" in err
    assert "would be overwritten by merge" in err
    assert (repository / "source.txt").read_text() == "local edit\n"

    monkeypatch.setenv("FAKE_PI_SPLIT_EMPTY", "1")
    assert run_campaign(pi, repository, tmp_path / "empty", goal) == 0
    assert capsys.readouterr().out == "nothing left of Goal\n"
    assert calls()[-1]["cwd"] == str(tmp_path / "empty" / "split")
    assert not (tmp_path / "empty" / "split").exists()
    assert not (tmp_path / "empty" / "items").exists()


def test_ship_in_herdr_runs_each_session_in_one_pane_and_closes_it(
    repository, pi, item, tmp_path, monkeypatch
):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    herdr = bin_dir / "herdr"
    herdr.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_HERDR} "$@"\n')
    herdr.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_HERDR_STATE", str(tmp_path / "herdr.json"))
    shipped = ship.ship(
        str(repository), "main", item, tmp_path / "run", command=str(pi), herdr="w1:p1"
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


def test_optimize_writes_back_the_templates_gepa_changed_and_stops_on_a_failed_rollout_or_reflection(
    repository, pi, item, tmp_path, monkeypatch
):
    # With PYTHONPATH on the copy, `prompts.DIRECTORY` is the copy's `prompts/`.
    copy = tmp_path / "copy"
    shutil.copytree(DIRECTORY.parent / "src", copy / "src")
    shutil.copytree(DIRECTORY, copy / "prompts")
    monkeypatch.setenv("PYTHONPATH", str(copy / "src"))

    def templates() -> dict[str, bytes]:
        return {path.name: path.read_bytes() for path in (copy / "prompts").glob("*.md")}

    def optimize(run: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "workflows.cli", "optimize", "--headless", "--pi", str(pi),
             "--repo", str(repository), "--rounds", "1", "--budget", "4",
             "--run-dir", str(tmp_path / run), str(item)],
            capture_output=True, text=True, check=False,
        )  # fmt: skip

    before = templates()
    monkeypatch.setenv("FAKE_PI_JUDGE_FAIL", "1")
    failed = optimize("failed")
    assert failed.returncode == 1
    assert f"rollout of {item} failed: judge reply has no answer" in failed.stderr
    assert templates() == before
    assert len(git(repository, "worktree", "list").splitlines()) == 1

    monkeypatch.delenv("FAKE_PI_JUDGE_FAIL")
    monkeypatch.setenv("FAKE_PI_REFLECT_FAIL", "1")
    unreflected = optimize("unreflected")
    assert unreflected.returncode == 1
    assert "reflection failed: pi exited with 1: reflection failed" in unreflected.stderr
    assert templates() == before
    assert len(git(repository, "worktree", "list").splitlines()) == 1

    monkeypatch.delenv("FAKE_PI_REFLECT_FAIL")
    head, sep, body = before["review.md"].partition(b"\n---\n")
    review = head + sep + b"Be brief.\n\n" + body
    (copy / "prompts" / "review.md").write_bytes(review)
    earlier = len(calls())
    optimized = optimize("unreflected")
    assert optimized.returncode == 0, optimized.stderr
    assert re.findall(r"changed prompts/\S+", optimized.stdout) == ["changed prompts/plan.md"]
    frontmatter = before["plan.md"].partition(b"\n---\n")[0] + b"\n---\n"
    plan = frontmatter + b"Plan this change in three bullets.\n\n$@\n"
    assert templates() == before | {"plan.md": plan, "review.md": review}
    assert len(git(repository, "worktree", "list").splitlines()) == 1
    reflections = [call for call in calls()[earlier:] if call["session"].startswith("reflect-")]
    assert [call["cwd"] for call in reflections] == [str(repository)]
    assert "3 FAIL source.txt:1 not needed" in reflections[0]["prompt"]
    assert "Did not ship: the review still said FIX after 1 rounds." in reflections[0]["prompt"]
