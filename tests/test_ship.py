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
from workflows.optimize import Rollout
from workflows.pi import Pi
from workflows.prompts import DIRECTORY, Template, load, render

FAKE_PI = Path(__file__).with_name("fake_pi.py")
FAKE_HERDR = Path(__file__).with_name("fake_herdr.py")
FAKE_GH = Path(__file__).with_name("fake_gh.py")


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
def gh(tmp_path, monkeypatch):
    script = tmp_path / "gh"
    script.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_GH} "$@"\n')
    script.chmod(0o755)
    monkeypatch.setenv("FAKE_GH_LOG", str(tmp_path / "publications.json"))
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")
    return script


@pytest.fixture
def item(tmp_path):
    path = tmp_path / "one.md"
    path.write_text("# Item one\n\nWrite source.txt.\n")
    return path


def calls():
    return json.loads(Path(os.environ["FAKE_PI_LOG"]).read_text())


def publications():
    path = Path(os.environ["FAKE_GH_LOG"])
    return json.loads(path.read_text()) if path.exists() else []


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
    assert histories[5][0]["reply"] == "Wrote source.txt."
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
        if call["session"].startswith("implement-"):
            assert "--tools" not in call["args"]
            assert call["args"][call["args"].index("--model") + 1] == "openai-codex/gpt-6.1-sol"
        else:
            assert call["args"][call["args"].index("--tools") + 1] == (
                "read,grep,find,ls,bash"
                if call["session"].startswith("judge-")
                else "read,grep,find,ls"
            )
    assert calls()[10]["cwd"] == str(run_dir / "judge")
    assert not (run_dir / "judge").exists()
    assert "Item one" in calls()[0]["prompt"] and calls()[2]["prompt"].startswith("Write a handoff")
    assert "Fix plan 1." in calls()[3]["prompt"]
    assert calls()[4]["prompt"].endswith("\n\n## reply\nWrote source.txt.")
    review = calls()[8]["prompt"]
    assert str(run_dir / "sessions" / "round-2-fix.patch") in review
    assert "Fix review 1." in review
    assert review.endswith("\n\n## reply\nWrote source.txt.")

    assert run("stopped", 1) == 1
    worktree = tmp_path / "stopped" / "worktree"
    assert git(repository, "log", "--format=%s", "main..ship/stopped") == "round 1"
    assert (worktree / "source.txt").read_text() == "implement 1\n"
    assert capsys.readouterr().out == f"stopped Item one after 1 rounds: {worktree}\n"


def test_ship_reviews_and_squashes_implementer_commits(
    repository, pi, item, tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("FAKE_PI_SELF_COMMIT", "1")
    run_dir = tmp_path / "run"
    assert main(
        ["ship", "--headless", "--pi", str(pi), "--repo", str(repository),
         "--rounds", "2", "--run-dir", str(run_dir), str(item)]
    ) == 0  # fmt: skip

    worktree = run_dir / "worktree"
    assert git(repository, "log", "--format=%s", "main..ship/run") == "Item one"
    assert (worktree / "source.txt").read_text() == "implement 1\nimplement 2\n"
    assert git(worktree, "status", "--porcelain") == ""
    assert git(worktree, "log", "-1", "--format=%(trailers:only)").splitlines() == [
        "Rounds: 2", "Judge: 0.83",
    ]  # fmt: skip
    sha = git(worktree, "rev-parse", "--short", "HEAD")
    out, err = capsys.readouterr()
    assert out == f"shipped Item one in 2 rounds, judge 0.83, {sha}\n"
    assert err == f"run directory: {run_dir}\n"
    assert [call["session"] for call in calls()] == [
        "plan-1", "plan-1", "plan-1", "implement-1", "review-1", "review-1", "review-1",
        "implement-2", "review-2", "review-2", "judge-1",
    ]  # fmt: skip

    patches = run_dir / "sessions"
    assert str(patches / "round-1.patch") in calls()[4]["prompt"]
    assert str(patches / "round-2.patch") in calls()[8]["prompt"]
    assert str(patches / "round-2-fix.patch") in calls()[8]["prompt"]
    assert "+implement 1\n" in (patches / "round-1.patch").read_text()
    assert "+implement 1\n+implement 2\n" in (patches / "round-2.patch").read_text()
    assert "\n implement 1\n+implement 2\n" in (patches / "round-2-fix.patch").read_text()


@pytest.mark.parametrize("review_fix", [False, True])
def test_ship_reviews_an_unchanged_round_after_earlier_changes(
    repository, pi, item, tmp_path, capsys, monkeypatch, review_fix
):
    monkeypatch.setenv("FAKE_PI_BLOCK_ROUND", "2")
    if review_fix:
        monkeypatch.setenv("FAKE_PI_REVIEW_FIX", "1")
    run_dir = tmp_path / "run"
    assert main(
        ["ship", "--headless", "--pi", str(pi), "--repo", str(repository),
         "--rounds", "2", "--run-dir", str(run_dir), str(item)]
    ) == (1 if review_fix else 0)  # fmt: skip

    worktree = run_dir / "worktree"
    assert (worktree / "source.txt").read_text() == "implement 1\n"
    assert git(worktree, "status", "--porcelain") == ""
    assert git(worktree, "log", "--format=%s", "main..HEAD") == (
        "round 1" if review_fix else "Item one"
    )
    assert [call["session"] for call in calls()] == [
        "plan-1", "plan-1", "plan-1", "implement-1", "review-1", "review-1", "review-1",
        "implement-2", "review-2", "review-2", "review-2" if review_fix else "judge-1",
    ]  # fmt: skip
    patches = run_dir / "sessions"
    review = calls()[8]["prompt"]
    assert str(patches / "round-2.patch") in review
    assert str(patches / "round-2-fix.patch") in review
    assert review.endswith("\n\n## reply\nCannot proceed without the missing requirements.")
    assert (patches / "round-2.patch").read_text() == (patches / "round-1.patch").read_text()
    assert "+implement 1\n" in (patches / "round-2.patch").read_text()
    assert (patches / "round-2-fix.patch").read_text() == "\n"
    out, err = capsys.readouterr()
    assert err == f"run directory: {run_dir}\n"
    if review_fix:
        assert out == f"stopped Item one after 2 rounds: {worktree}\n"
        assert git(worktree, "log", "-1", "--format=%(trailers:only)") == ""
    else:
        assert git(worktree, "log", "-1", "--format=%(trailers:only)").splitlines() == [
            "Rounds: 2", "Judge: 0.83",
        ]  # fmt: skip
        sha = git(worktree, "rev-parse", "--short", "HEAD")
        assert out == f"shipped Item one in 2 rounds, judge 0.83, {sha}\n"
        assert calls()[10]["cwd"] == str(run_dir / "judge")


def test_ship_blocks_without_changes_from_the_starting_commit_without_reviewing_or_judging(
    repository, pi, item, tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("FAKE_PI_BLOCK_ROUND", "1")
    base = git(repository, "rev-parse", "HEAD")
    run_dir = tmp_path / "blocked"
    assert main(
        ["ship", "--headless", "--pi", str(pi), "--repo", str(repository),
         "--run-dir", str(run_dir), str(item)]
    ) == 1  # fmt: skip

    worktree = run_dir / "worktree"
    out, err = capsys.readouterr()
    assert out == (
        f"blocked Item one after 1 rounds: {worktree}\n"
        "Cannot proceed without the missing requirements.\n"
    )
    assert err == f"run directory: {run_dir}\n"
    assert worktree.is_dir()
    assert git(repository, "rev-parse", "refs/heads/main") == base
    assert git(repository, "rev-parse", "refs/heads/ship/blocked") == git(
        worktree, "rev-parse", "HEAD"
    )
    assert git(worktree, "rev-parse", "HEAD") == base
    assert git(worktree, "log", "--format=%s", "main..HEAD") == ""
    assert git(worktree, "status", "--porcelain") == ""
    assert not (worktree / "source.txt").exists()
    assert [call["session"] for call in calls()] == [
        "plan-1", "plan-1", "plan-1", "implement-1",
    ]  # fmt: skip
    assert list((run_dir / "sessions").glob("*.patch")) == []
    assert not (run_dir / "judge").exists()


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
    assert git(repository, "rev-parse", f"refs/heads/campaign/{run_dir.name}") == head
    assert not (run_dir / "items" / "2.md").exists()
    return worktree, git(repository, "rev-parse", "--short", f"ship/{run_dir.name}-1")


def test_campaign_publishes_accepted_items_in_one_pr_and_a_draft_after_a_stop(
    repository, pi, gh, tmp_path, capsys, monkeypatch
):
    goal = tmp_path / "goal.md"
    goal.write_text("\n  \n")
    with pytest.raises(ValueError, match=re.escape(str(goal))):
        run_campaign(pi, repository, tmp_path / "empty-goal", goal)
    goal.write_text("# Goal\n\nWrite two items.\n")
    topic = git(repository, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "topic base")
    git(repository, "branch", "topic", topic)
    git(repository, "symbolic-ref", "HEAD", "refs/heads/unborn")
    for base in ("unborn", "main*", "main^{commit}"):
        with pytest.raises(
            ValueError, match=re.escape(f"--base {base} is not a branch with a commit")
        ):
            run_campaign(pi, repository, tmp_path / "invalid", goal, "--base", base)
    git(repository, "symbolic-ref", "HEAD", "refs/heads/main")
    assert not Path(os.environ["FAKE_PI_LOG"]).exists()
    assert len(git(repository, "worktree", "list").splitlines()) == 1

    head = git(repository, "rev-parse", "refs/heads/main")
    origin = tmp_path / "origin.git"
    origin.mkdir()
    git(origin, "init", "--bare", "-q")
    git(repository, "remote", "add", "origin", str(origin))
    git(repository, "push", "origin", "refs/heads/main:refs/heads/main")
    push_log = tmp_path / "pushes"
    monkeypatch.setenv("FAKE_GIT_PUSH_LOG", str(push_log))
    hook = origin / "hooks" / "pre-receive"
    hook.write_text(
        f"#!{sys.executable}\n"
        "import os\nimport sys\nfrom pathlib import Path\n"
        "with Path(os.environ['FAKE_GIT_PUSH_LOG']).open('a') as log:\n"
        "    log.write(sys.stdin.read())\n"
        "if os.environ.get('FAKE_GIT_PUSH_FAIL') == '1':\n"
        "    sys.exit('origin rejected campaign')\n"
    )
    hook.chmod(0o755)
    decoy = git(repository, "commit-tree", "HEAD^{tree}", "-m", "decoy")
    tags = ("main", "topic", "campaign/run", "ship/run-1", "ship/run-2", "tag-only")
    for tag in tags:
        git(repository, "tag", tag, decoy)
    with pytest.raises(ValueError, match="--base tag-only is not a branch with a commit"):
        run_campaign(pi, repository, tmp_path / "tag-only", goal, "--base", "tag-only")

    run_dir = tmp_path / "run"
    assert run_campaign(pi, repository, run_dir, goal, "--base", "topic", "--gh", str(gh)) == 0
    campaign_ref = "refs/heads/campaign/run"
    assert (
        git(repository, "log", "--format=%s", campaign_ref)
        == "Item two\nItem one\ntopic base\ninit"
    )
    assert git(repository, "rev-parse", "refs/heads/main") == head
    assert git(repository, "rev-parse", "refs/heads/topic") == topic
    assert git(repository, "symbolic-ref", "HEAD") == "refs/heads/main"
    assert git(repository, "status", "--porcelain") == ""
    assert [git(repository, "rev-parse", f"refs/tags/{tag}") for tag in tags] == [decoy] * len(tags)
    for commit in (f"{campaign_ref}~1", campaign_ref):
        trailers = git(repository, "log", "-1", "--format=%(trailers:only)", commit)
        assert trailers.splitlines() == ["Rounds: 2", "Judge: 0.83"]
        assert git(repository, "show", "--format=", "--numstat", commit) == "2\t0\tsource.txt"
    assert git(origin, "rev-parse", campaign_ref) == git(repository, "rev-parse", campaign_ref)
    assert (
        git(origin, "show", f"{campaign_ref}:source.txt")
        == ("implement 1\nimplement 2\n" * 2).strip()
    )
    assert git(origin, "rev-parse", "refs/heads/main") == head
    assert not (repository / "source.txt").exists()
    assert (run_dir / "items" / "1.md").read_text() == "# Item one\n\nWrite source.txt.\n"
    assert (run_dir / "items" / "2.md").read_text() == "# Item two\n\nExtend source.txt.\n"
    shipped = [
        "plan-1", "plan-1", "plan-1", "implement-1", "review-1", "review-1", "review-1",
        "implement-2", "review-2", "review-2", "judge-1",
    ]  # fmt: skip
    assert [call["session"] for call in calls()] == ["split-1", *shipped, *shipped, "pr-1"]
    writer = calls()[-1]
    accepted_head = git(repository, "rev-parse", campaign_ref)
    assert writer["cwd"] == str(run_dir / "pr")
    assert writer["head"] == writer["pushed_head"] == accepted_head
    assert writer["detached"]
    assert writer["args"][writer["args"].index("--mode") + 1] == "json"
    assert writer["args"][writer["args"].index("--tools") + 1] == "read,grep,find,ls,bash"
    assert writer["args"][writer["args"].index("--model") + 1] == "openai-codex/gpt-6-astra"
    assert writer["args"][writer["args"].index("--thinking") + 1] == "xhigh"
    assert "--session" not in writer["args"]
    assert load("pr") in writer["prompt"]
    assert "Load and follow the `writing-pr` skill." in writer["prompt"]
    assert "inspect the aggregate diff" in writer["prompt"]
    assert "explain the stopped work item and reason" in writer["prompt"]
    assert "## goal\n# Goal\n\nWrite two items." in writer["prompt"]
    assert "## base\nrefs/heads/topic" in writer["prompt"]
    assert f"## head\n{accepted_head}" in writer["prompt"]
    assert "## stop\nNo early stop." in writer["prompt"]
    assert writer["prompt"].endswith(
        "End with a ```json fenced block with a JSON array of exactly two non-blank strings: "
        "[title, body], with a single-line title and a markdown body."
    )
    record = run_dir / "sessions" / "pr-1"
    assert (record / "prompt-1.md").read_text() == writer["prompt"]
    assert list(record.glob("*.jsonl"))
    assert not (record / "prompt-2.md").exists()
    assert not (run_dir / "pr").exists()
    assert calls()[0]["args"][calls()[0]["args"].index("--tools") + 1] == "read,grep,find,ls"
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
        for commit in (f"{campaign_ref}~1", campaign_ref)
    )
    url = "https://example.test/pull/1"
    assert capsys.readouterr().out == (
        f"shipped Item one in 2 rounds, judge 0.83, {one}\naccepted Item one into campaign/run\n"
        f"shipped Item two in 2 rounds, judge 0.83, {two}\naccepted Item two into campaign/run\n"
        f"{url}\n"
    )
    title = "Write and extend source.txt"
    body = "- Add source.txt.\n- Extend source.txt."
    fallback = "# Goal\n\nWrite two items.\n\nAccepted work items:\n- Item one\n- Item two"
    assert publications() == [{
        "args": ["pr", "create", "--base", "topic", "--head", "campaign/run",
                 "--title", title, "--body", body],
        "cwd": str(repository),
        "head": git(repository, "rev-parse", campaign_ref),
    }]  # fmt: skip
    assert len(push_log.read_text().splitlines()) == 1

    monkeypatch.setenv("FAKE_PI_JUDGE_ZERO", "1")
    assert run_campaign(pi, repository, tmp_path / "zero", goal) == 1
    worktree, sha = kept(repository, tmp_path / "zero", head)
    assert capsys.readouterr().out == (
        f"shipped Item one in 2 rounds, judge 0.00, {sha}\n"
        f"not accepted Item one: judge 0.00: {worktree}\n"
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
        f"not accepted Item one: judge failed: {worktree}\n"
    )
    monkeypatch.delenv("FAKE_PI_JUDGE_FAIL")
    assert run_campaign(pi, repository, tmp_path / "stopped", goal, "--rounds", "1") == 1
    worktree, _ = kept(repository, tmp_path / "stopped", head)
    assert git(repository, "log", "--format=%s", "refs/heads/main..ship/stopped-1") == "round 1"
    assert capsys.readouterr().out == f"stopped Item one after 1 rounds: {worktree}\n"

    monkeypatch.setenv("FAKE_PI_BLOCK_ROUND", "1")
    earlier = len(calls())
    assert run_campaign(pi, repository, tmp_path / "blocked", goal) == 1
    worktree, _ = kept(repository, tmp_path / "blocked", head)
    assert git(repository, "log", "--format=%s", "refs/heads/main..ship/blocked-1") == ""
    assert capsys.readouterr().out == (
        f"blocked Item one after 1 rounds: {worktree}\n"
        "Cannot proceed without the missing requirements.\n"
    )
    assert [call["session"] for call in calls()[earlier:]] == [
        "split-1", "plan-1", "plan-1", "plan-1", "implement-1",
    ]  # fmt: skip
    assert not (tmp_path / "blocked" / "blocked-2").exists()
    monkeypatch.delenv("FAKE_PI_BLOCK_ROUND")
    assert len(publications()) == len(push_log.read_text().splitlines()) == 1

    (repository / "README.md").write_text("staged edit\n")
    git(repository, "add", "README.md")
    (repository / "README.md").write_text("unstaged edit\n")
    (repository / "source.txt").write_text("local edit\n")
    status = git(repository, "status", "--porcelain")
    index = (repository / ".git" / "index").read_bytes()
    assert run_campaign(pi, repository, tmp_path / "dirty", goal) == 0
    assert (repository / ".git" / "index").read_bytes() == index
    assert git(repository, "status", "--porcelain") == status
    assert git(repository, "symbolic-ref", "HEAD") == "refs/heads/main"
    assert git(repository, "rev-parse", "refs/heads/main") == head
    assert (repository / "README.md").read_text() == "unstaged edit\n"
    assert (repository / "source.txt").read_text() == "local edit\n"
    assert git(repository, "branch", "--list", "ship/dirty-*") == ""
    assert git(origin, "rev-parse", "refs/heads/campaign/dirty") == git(
        repository, "rev-parse", "refs/heads/campaign/dirty"
    )
    assert publications()[-1]["args"] == [
        "pr", "create", "--base", "main", "--head", "campaign/dirty",
        "--title", title, "--body", body,
    ]  # fmt: skip
    assert capsys.readouterr().out.endswith(f"{url}\n")

    monkeypatch.setenv("FAKE_PI_CONTROL_ITEM", "2")
    for label, flag, value, reason in (
        ("partial-blocked", "FAKE_PI_BLOCK_ROUND", "1",
         "blocked after 1 rounds: Cannot proceed without the missing requirements."),
        ("partial-stopped", "FAKE_PI_REVIEW_FIX", "1", "stopped after 2 rounds"),
        ("partial-zero", "FAKE_PI_JUDGE_ZERO", "1", "judge 0.00"),
        ("partial-unjudged", "FAKE_PI_JUDGE_FAIL", "1", "judge failed"),
    ):  # fmt: skip
        monkeypatch.setenv(flag, value)
        run_dir = tmp_path / label
        before = len(publications())
        assert run_campaign(pi, repository, run_dir, goal, "--rounds", "2") == 1
        monkeypatch.delenv(flag)
        campaign_ref = f"refs/heads/campaign/{label}"
        assert git(repository, "log", "--format=%s", campaign_ref) == "Item one\ninit"
        assert git(origin, "rev-parse", campaign_ref) == git(repository, "rev-parse", campaign_ref)
        assert git(origin, "show", f"{campaign_ref}:source.txt") == "implement 1\nimplement 2"
        assert not (run_dir / f"{label}-1" / "worktree").exists()
        assert git(repository, "branch", "--list", f"ship/{label}-1") == ""
        worktree = run_dir / f"{label}-2" / "worktree"
        assert worktree.is_dir()
        assert git(repository, "rev-parse", f"refs/heads/ship/{label}-2") == git(
            worktree, "rev-parse", "HEAD"
        )
        assert len(publications()) == before + 1
        assert publications()[-1]["args"] == [
            "pr", "create", "--base", "main", "--head", f"campaign/{label}",
            "--title", title, "--draft", "--body",
            f"{body}\n\nStopped at Item two: {reason}",
        ]  # fmt: skip
        writer = calls()[-1]
        accepted_head = git(repository, "rev-parse", campaign_ref)
        assert writer["session"] == "pr-1"
        assert writer["head"] == writer["pushed_head"] == accepted_head
        assert writer["detached"]
        assert "## base\nrefs/heads/main" in writer["prompt"]
        assert f"## head\n{accepted_head}" in writer["prompt"]
        assert f"## stop\nStopped at Item two: {reason}" in writer["prompt"]
        assert not (run_dir / "pr").exists()
        assert list((run_dir / "sessions" / "pr-1").glob("*.jsonl"))
        if label != "partial-blocked":
            assert writer["head"] != git(worktree, "rev-parse", "HEAD")
        assert capsys.readouterr().out.endswith(f"{url}\n")
    monkeypatch.delenv("FAKE_PI_CONTROL_ITEM")

    hook = repository / ".git" / "hooks" / "reference-transaction"
    hook.write_text(
        f"#!{sys.executable}\n"
        "import subprocess\nimport sys\n"
        "if sys.argv[1] == 'prepared':\n"
        "    for line in sys.stdin:\n"
        "        old, new, ref = line.split()\n"
        "        if ref == 'refs/heads/campaign/advance':\n"
        "            subject = subprocess.run(['git', 'log', '-1', '--format=%s', new],\n"
        "                capture_output=True, text=True, check=True).stdout.strip()\n"
        "            if subject == 'Item two':\n"
        "                sys.exit('campaign ref rejected')\n"
        "        if ref == 'refs/heads/ship/execute-2':\n"
        "            sys.exit('item branch creation rejected')\n"
        "        if ref == 'refs/heads/ship/cleanup-1' and new == '0' * len(new):\n"
        "            sys.exit('item branch deletion rejected')\n"
    )
    hook.chmod(0o755)
    assert run_campaign(pi, repository, tmp_path / "advance", goal) == 1
    assert git(repository, "log", "--format=%s", "refs/heads/campaign/advance") == "Item one\ninit"
    assert (tmp_path / "advance" / "advance-2" / "worktree").is_dir()
    assert git(repository, "branch", "--list", "--format=%(refname)", "ship/advance-2") == (
        "refs/heads/ship/advance-2"
    )
    assert "--draft" in publications()[-1]["args"]
    assert "Stopped at Item two: git update-ref failed:" in publications()[-1]["args"][-1]
    out, err = capsys.readouterr()
    assert out.endswith(f"{url}\n")
    assert "campaign failed on Item two:" in err and "campaign ref rejected" in err

    for label, name, command, evidence in (
        ("execute", "Item two", "worktree", "item branch creation rejected"),
        ("cleanup", "Item one", "branch", "item branch deletion rejected"),
    ):
        run_dir = tmp_path / label
        earlier = len(calls())
        before = len(publications())
        pushes = len(push_log.read_text().splitlines())
        assert run_campaign(pi, repository, run_dir, goal) == 1
        campaign_ref = f"refs/heads/campaign/{label}"
        accepted_head = git(repository, "rev-parse", campaign_ref)
        assert git(repository, "log", "--format=%s", campaign_ref) == "Item one\ninit"
        assert git(origin, "rev-parse", campaign_ref) == accepted_head
        assert git(origin, "show", f"{campaign_ref}:source.txt") == "implement 1\nimplement 2"
        assert len(push_log.read_text().splitlines()) == pushes + 1
        assert len(publications()) == before + 1
        publication = publications()[-1]
        assert publication["head"] == accepted_head
        assert publication["args"][:-1] == [
            "pr", "create", "--base", "main", "--head", f"campaign/{label}",
            "--title", title, "--draft", "--body",
        ]  # fmt: skip
        assert publication["args"][-1].startswith(
            f"{body}\n\nStopped at {name}: git {command} failed:"
        )
        assert evidence in publication["args"][-1]
        assert [call["session"] for call in calls()[earlier:]] == ["split-1", *shipped, "pr-1"]
        assert calls()[-1]["head"] == calls()[-1]["pushed_head"] == accepted_head
        assert calls()[-1]["detached"]
        assert not (run_dir / "pr").exists()
        assert not (run_dir / f"{label}-1" / "worktree").exists()
        assert not (run_dir / f"{label}-2" / "worktree").exists()
        assert (run_dir / "items" / "2.md").exists() == (label == "execute")
        if label == "cleanup":
            assert git(repository, "rev-parse", "refs/heads/ship/cleanup-1") == accepted_head
        else:
            assert git(repository, "branch", "--list", "ship/execute-*") == ""
        assert git(repository, "rev-parse", "refs/heads/main") == head
        assert git(origin, "rev-parse", "refs/heads/main") == head
        assert git(repository, "symbolic-ref", "HEAD") == "refs/heads/main"
        assert git(repository, "status", "--porcelain") == status
        assert (repository / ".git" / "index").read_bytes() == index
        assert (repository / "README.md").read_text() == "unstaged edit\n"
        assert (repository / "source.txt").read_text() == "local edit\n"
        out, err = capsys.readouterr()
        assert out.endswith(f"{url}\n")
        assert f"campaign failed on {name}: git {command} failed:" in err
        assert evidence in err
    hook.unlink()

    for label, flag, value, evidence in (
        ("writer-malformed", "FAKE_PI_PR_REPLY", "No PR text.", "No PR text."),
        ("writer-short", "FAKE_PI_PR_REPLY", '```json\n["New title"]\n```', "['New title']"),
        ("writer-long", "FAKE_PI_PR_REPLY", '```json\n["New title", "Body", "Extra"]\n```',
         "['New title', 'Body', 'Extra']"),
        ("writer-multiline", "FAKE_PI_PR_REPLY", '```json\n["New\\ntitle", "Body"]\n```',
         "single-line title"),
        ("writer-failed", "FAKE_PI_PR_FAIL", "1", "pi exited with 1: PR writer failed"),
        ("draft-writer-failed", "FAKE_PI_PR_FAIL", "1", "pi exited with 1: PR writer failed"),
    ):  # fmt: skip
        draft = label == "draft-writer-failed"
        if draft:
            monkeypatch.setenv("FAKE_PI_CONTROL_ITEM", "2")
            monkeypatch.setenv("FAKE_PI_BLOCK_ROUND", "1")
        monkeypatch.setenv(flag, value)
        run_dir = tmp_path / label
        earlier = len(calls())
        before = len(publications())
        pushes = len(push_log.read_text().splitlines())
        assert run_campaign(pi, repository, run_dir, goal, "--rounds", "2") == int(draft)
        monkeypatch.delenv(flag)
        if draft:
            monkeypatch.delenv("FAKE_PI_CONTROL_ITEM")
            monkeypatch.delenv("FAKE_PI_BLOCK_ROUND")
        expected = fallback
        args = [
            "pr", "create", "--base", "main", "--head", f"campaign/{label}",
            "--title", "Goal",
        ]  # fmt: skip
        if draft:
            expected = (
                "# Goal\n\nWrite two items.\n\nAccepted work items:\n- Item one"
                "\n\nStopped at Item two: blocked after 1 rounds: "
                "Cannot proceed without the missing requirements."
            )
            args.append("--draft")
        assert publications()[-1]["args"] == [*args, "--body", expected]
        assert len(publications()) == before + 1
        assert len(push_log.read_text().splitlines()) == pushes + 1
        assert [call["session"] for call in calls()[earlier:]].count("pr-1") == 1
        writer = calls()[-1]
        assert writer["head"] == writer["pushed_head"] == publications()[-1]["head"]
        assert writer["detached"]
        assert not (run_dir / "pr").exists()
        record = run_dir / "sessions" / "pr-1"
        assert (record / "prompt-1.md").read_text() == writer["prompt"]
        assert (record / "pi.log").exists()
        assert bool(list(record.glob("*.jsonl"))) == (flag == "FAKE_PI_PR_REPLY")
        out, err = capsys.readouterr()
        assert out.endswith(f"{url}\n")
        assert f"PR text failed for campaign/{label}:" in err
        assert evidence in err and "using goal text" in err
        assert "publication failed" not in err

    real_git = shutil.which("git")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    failing_git = bin_dir / "git"
    failing_git.write_text(
        f"#!{sys.executable}\n"
        "import os\nimport sys\n"
        "args = sys.argv[1:]\n"
        "if args[:2] == ['worktree', 'add'] and args[-2].endswith('/writer-setup/pr'):\n"
        "    sys.exit('PR worktree setup refused')\n"
        "if args[:2] == ['worktree', 'remove'] and args[-1].endswith('/writer-cleanup/pr'):\n"
        "    sys.exit('PR worktree cleanup refused')\n"
        f"os.execv({real_git!r}, [{real_git!r}, *args])\n"
    )
    failing_git.chmod(0o755)
    with monkeypatch.context() as environment:
        environment.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
        for label, evidence in (
            ("writer-setup", "PR worktree setup refused"),
            ("writer-cleanup", "PR worktree cleanup refused"),
        ):
            run_dir = tmp_path / label
            earlier = len(calls())
            before = len(publications())
            assert run_campaign(pi, repository, run_dir, goal) == 0
            assert publications()[-1]["args"] == [
                "pr", "create", "--base", "main", "--head", f"campaign/{label}",
                "--title", "Goal", "--body", fallback,
            ]  # fmt: skip
            assert len(publications()) == before + 1
            assert [call["session"] for call in calls()[earlier:]].count("pr-1") == (
                0 if label == "writer-setup" else 1
            )
            assert (run_dir / "pr").exists() == (label == "writer-cleanup")
            out, err = capsys.readouterr()
            assert out.endswith(f"{url}\n")
            assert f"PR text failed for campaign/{label}: git worktree failed:" in err
            assert evidence in err and "using goal text" in err
            assert "publication failed" not in err
    git(repository, "worktree", "remove", "--force", str(tmp_path / "writer-cleanup" / "pr"))

    before = len(publications())
    earlier = len(calls())
    monkeypatch.setenv("FAKE_GIT_PUSH_FAIL", "1")
    assert run_campaign(pi, repository, tmp_path / "push-failed", goal) == 1
    monkeypatch.delenv("FAKE_GIT_PUSH_FAIL")
    assert len(publications()) == before
    assert [call["session"] for call in calls()[earlier:]] == ["split-1", *shipped, *shipped]
    assert not (tmp_path / "push-failed" / "pr").exists()
    assert not (tmp_path / "push-failed" / "sessions" / "pr-1").exists()
    assert git(origin, "branch", "--list", "campaign/push-failed") == ""
    assert git(repository, "log", "--format=%s", "refs/heads/campaign/push-failed") == (
        "Item two\nItem one\ninit"
    )
    out, err = capsys.readouterr()
    assert url not in out
    assert "publication failed for campaign/push-failed: git push failed:" in err
    assert "origin rejected campaign" in err

    monkeypatch.setenv("FAKE_GH_FAIL", "1")
    assert run_campaign(pi, repository, tmp_path / "pr-failed", goal) == 1
    monkeypatch.delenv("FAKE_GH_FAIL")
    assert len(publications()) == before + 1
    assert git(origin, "rev-parse", "refs/heads/campaign/pr-failed") == git(
        repository, "rev-parse", "refs/heads/campaign/pr-failed"
    )
    out, err = capsys.readouterr()
    assert url not in out
    assert "publication failed for campaign/pr-failed:" in err
    assert "PR creation refused" in err and "GitHub unavailable" in err

    missing = tmp_path / "missing-gh"
    assert run_campaign(pi, repository, tmp_path / "no-gh", goal, "--gh", str(missing)) == 1
    assert len(publications()) == before + 1
    assert git(origin, "rev-parse", "refs/heads/campaign/no-gh") == git(
        repository, "rev-parse", "refs/heads/campaign/no-gh"
    )
    out, err = capsys.readouterr()
    assert url not in out
    assert "publication failed for campaign/no-gh:" in err and str(missing) in err

    herdr = tmp_path / "herdr"
    herdr.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_HERDR} "$@"\n')
    herdr.chmod(0o755)
    state = tmp_path / "campaign-herdr.json"
    run_dir = tmp_path / "visible"
    with monkeypatch.context() as environment:
        environment.setenv("HERDR_ENV", "1")
        environment.setenv("HERDR_PANE_ID", "w1:p1")
        environment.setenv("FAKE_HERDR_STATE", str(state))
        assert run_campaign(pi, repository, run_dir, goal) == 0
    herdr_calls = json.loads(state.read_text())["calls"]
    [start] = [
        call for call in herdr_calls
        if call[:2] == ["agent", "start"]
        and call[call.index("--session-dir") + 1] == str(run_dir / "sessions" / "pr-1")
    ]  # fmt: skip
    assert start[start.index("--tools") + 1] == "read,grep,find,ls,bash"
    assert herdr_calls[-1] == ["pane", "close", start[start.index("--pane") + 1]]
    assert calls()[-1]["cwd"] == str(run_dir / "pr")
    assert calls()[-1]["detached"]
    assert "--mode" not in calls()[-1]["args"]
    assert not (run_dir / "pr").exists()
    assert list((run_dir / "sessions" / "pr-1").glob("*.jsonl"))
    assert publications()[-1]["args"] == [
        "pr", "create", "--base", "main", "--head", "campaign/visible",
        "--title", title, "--body", body,
    ]  # fmt: skip
    assert capsys.readouterr().out.endswith(f"{url}\n")

    before = len(publications()), push_log.read_text()
    monkeypatch.setenv("FAKE_PI_SPLIT_EMPTY", "1")
    assert run_campaign(pi, repository, tmp_path / "empty", goal) == 0
    assert capsys.readouterr().out == "nothing left of Goal\n"
    assert calls()[-1]["cwd"] == str(tmp_path / "empty" / "split")
    assert not (tmp_path / "empty" / "split").exists()
    assert not (tmp_path / "empty" / "items").exists()
    assert (len(publications()), push_log.read_text()) == before
    assert git(repository, "rev-parse", "refs/heads/main") == head
    assert (repository / ".git" / "index").read_bytes() == index
    assert (repository / "README.md").read_text() == "unstaged edit\n"
    assert (repository / "source.txt").read_text() == "local edit\n"


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

    assert shipped.status == "shipped"
    assert shipped.head == git(repository, "rev-parse", "refs/heads/ship/run")
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
    for session, call in zip(sessions, starts, strict=True):
        if session.startswith("implement-"):
            assert "--tools" not in call
        else:
            assert call[call.index("--tools") + 1] == (
                "read,grep,find,ls,bash" if session.startswith("judge-") else "read,grep,find,ls"
            )
    assert starts[0] == starts[1]
    names = [call[2] for call in starts[1:]]
    assert [prompts.count(name) for name in names] == [3, 1, 3, 1, 2, 1]
    assert len(splits) == len(closes) == 6
    assert [call[call.index("--pane") + 1] for call in starts[1:]] == [call[2] for call in closes]


def test_optimize_scores_rollouts_updates_templates_and_stops_on_errors(
    repository, pi, item, tmp_path, monkeypatch
):
    base = git(repository, "rev-parse", "HEAD")
    monkeypatch.setenv("FAKE_PI_BLOCK_ROUND", "1")
    run_dir = tmp_path / "blocked"
    result = Rollout(repository, base, run_dir, str(pi), None, 3)(
        item=item.read_text(), path=str(item)
    )
    assert result.score == 0
    assert result.feedback == (
        "Did not ship: blocked in round 1 with "
        "no changes from the ship's starting commit.\n"
        "Cannot proceed without the missing requirements."
    )
    assert [call["session"] for call in calls()] == [
        "plan-1", "plan-1", "plan-1", "implement-1",
    ]  # fmt: skip
    [folder] = (run_dir / "rollouts").iterdir()
    assert not (folder / "worktree").exists()
    assert not (folder / "judge").exists()
    assert len(git(repository, "worktree", "list").splitlines()) == 1
    assert git(repository, "rev-parse", "HEAD") == base
    monkeypatch.delenv("FAKE_PI_BLOCK_ROUND")

    # With PYTHONPATH on the copy, `prompts.DIRECTORY` is the copy's `prompts/`.
    copy = tmp_path / "copy"
    shutil.copytree(DIRECTORY.parent / "src", copy / "src")
    shutil.copytree(DIRECTORY, copy / "prompts")
    monkeypatch.setenv("PYTHONPATH", str(copy / "src"))

    def templates() -> dict[str, bytes]:
        return {path.name: path.read_bytes() for path in (copy / "prompts").glob("*.md")}

    def optimize(run: str, rounds: str = "1") -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "workflows.cli", "optimize", "--headless", "--pi", str(pi),
             "--repo", str(repository), "--rounds", rounds, "--budget", "4",
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
    reflections = [call for call in calls() if call["session"].startswith("reflect-")]
    assert "Did not ship: the review still said FIX after 1 rounds." in reflections[-1]["prompt"]
    assert templates() == before
    assert len(git(repository, "worktree", "list").splitlines()) == 1

    monkeypatch.delenv("FAKE_PI_REFLECT_FAIL")
    head, sep, body = before["review.md"].partition(b"\n---\n")
    review = head + sep + b"Be brief.\n\n" + body
    (copy / "prompts" / "review.md").write_bytes(review)
    earlier = len(calls())
    optimized = optimize("unreflected", rounds="2")
    assert optimized.returncode == 0, optimized.stderr
    assert re.findall(r"changed prompts/\S+", optimized.stdout) == ["changed prompts/plan.md"]
    frontmatter = before["plan.md"].partition(b"\n---\n")[0] + b"\n---\n"
    plan = frontmatter + b"Plan this change in three bullets.\n\n$@\n"
    assert templates() == before | {"plan.md": plan, "review.md": review}
    assert len(git(repository, "worktree", "list").splitlines()) == 1
    reflections = [call for call in calls()[earlier:] if call["session"].startswith("reflect-")]
    assert [call["cwd"] for call in reflections] == [str(repository)]
    for call in reflections:
        assert call["args"][call["args"].index("--tools") + 1] == "read,grep,find,ls"
    assert "3 FAIL source.txt:1 not needed" in reflections[0]["prompt"]
    assert "The review said SHIP in round 2." in reflections[0]["prompt"]
