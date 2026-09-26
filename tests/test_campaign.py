import json
import os
import subprocess
import sys
from pathlib import Path

import dspy
import pytest

from workflows.cli import main, parser
from workflows.workflows import campaign

FAKE_PI = Path(__file__).with_name("fake_pi.py")
FAKE_HERDR = Path(__file__).with_name("fake_herdr.py")


@pytest.fixture
def repository(tmp_path, monkeypatch):
    # An empty home: the stage skills come from the repository, not from this machine.
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / "README.md").write_text("hello\n")
    for skill in ("ponytail", "thermo-nuclear-code-quality-review"):
        path = repo / ".agents" / "skills" / skill / "SKILL.md"
        path.parent.mkdir(parents=True)
        path.write_text(f"---\nname: {skill}\ndescription: d\n---\nBody\n")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
        cwd=repo,
        check=True,
    )
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
def closed(monkeypatch):
    names = []
    monkeypatch.setattr(
        "workflows.pi.Session.close", lambda self: names.append(self.directory.name)
    )
    return names


def calls():
    return json.loads(Path(os.environ["FAKE_PI_LOG"]).read_text())


def test_campaign_runs_plan_implement_review_fix_review_in_fresh_sessions(
    repository, pi, tmp_path, closed
):
    run_dir = tmp_path / "run"
    workflow = campaign.Workflow(command=str(pi))
    result = workflow(goal="Finish source.txt", repository=str(repository), run_dir=str(run_dir))

    assert result.status == "completed"
    assert result.evidence["passed"] is True
    kinds = [call["kind"] for call in calls()]
    assert kinds == ["plan", "plan", "implement", "review", "fix", "evaluate", "review"]
    assert (run_dir / "worktree" / "source.txt").read_text() == "finished"
    # The repair turn continues the plan session; every other turn is a fresh session.
    sessions = ["--session" in call["args"] for call in calls()]
    assert sessions == [False, True, False, False, False, False, False]
    for index, call in enumerate(calls()):
        if call["kind"] != "evaluate":
            assert call["cwd"] == str(run_dir / "worktree")
            assert ("Campaign brief" in call["prompt"]) == (index != 1)
    plan, implement, review, evaluate = (calls()[i] for i in (0, 2, 3, 5))
    assert plan["prompt"].startswith("/skill:ponytail ")
    assert (
        "--tools" in plan["args"] and "edit" not in plan["args"][plan["args"].index("--tools") + 1]
    )
    assert "edit" in implement["args"][implement["args"].index("--tools") + 1]
    assert "Fix the edge case." in calls()[4]["prompt"]
    assert "exit code 1" in review["prompt"]
    assert "--no-tools" in evaluate["args"]
    state = json.loads((run_dir / "state.json").read_text())
    assert state["acceptance"]["commands"] == ['test "$(cat source.txt)" = finished']
    assert (run_dir / "verification" / "2" / "diff.patch").read_text().count("finished") == 1
    assert closed == ["plan-1", "implement-1", "review-1", "fix-1", "evaluate-1", "review-2"]


def test_a_stage_that_raises_is_closed_recorded_and_its_worktree_removed(
    repository, pi, tmp_path, closed, monkeypatch
):
    monkeypatch.setenv("FAKE_PI_FAIL", "implement")
    run_dir = tmp_path / "run"
    workflow = campaign.Workflow(command=str(pi), keep_worktree=False)
    with pytest.raises(RuntimeError, match="pi exited with 1"):
        workflow(goal="g", repository=str(repository), run_dir=str(run_dir))
    assert closed == ["plan-1", "implement-1"]
    state = json.loads((run_dir / "state.json").read_text())
    assert state["status"] == "failed"
    assert state["result"] == "implement stage raised: pi exited with 1: pi failed"
    assert not (run_dir / "worktree").exists()
    worktrees = subprocess.run(
        ["git", "worktree", "list"], cwd=repository, capture_output=True, text=True, check=True
    )
    assert worktrees.stdout.count("\n") == 1


def test_campaign_in_herdr_runs_each_session_in_its_own_pane_and_closes_it(
    repository, pi, tmp_path, monkeypatch
):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    herdr = bin_dir / "herdr"
    herdr.write_text(f'#!/bin/sh\nexec {sys.executable} {FAKE_HERDR} "$@"\n')
    herdr.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_HERDR_STATE", str(tmp_path / "herdr.json"))
    run_dir = tmp_path / "run"
    workflow = campaign.Workflow(command=str(pi), herdr="w1:p1")
    result = workflow(goal="Finish source.txt", repository=str(repository), run_dir=str(run_dir))

    assert result.status == "completed"
    herdr_calls = json.loads((tmp_path / "herdr.json").read_text())["calls"]
    splits = [call for call in herdr_calls if call[:2] == ["pane", "split"]]
    starts = [call for call in herdr_calls if call[:2] == ["agent", "start"]]
    closes = [call for call in herdr_calls if call[:2] == ["pane", "close"]]
    assert all(call[call.index("--pane") + 1] == "w1:p1" for call in splits)
    sessions = [Path(call[call.index("--session-dir") + 1]).name for call in starts]
    assert sessions == ["plan-1", "implement-1", "review-1", "fix-1", "evaluate-1", "review-2"]
    # The plan's repair turn is a second prompt to the same agent, not a new pane.
    assert [call[:2] for call in herdr_calls[:4]] == [
        ["pane", "split"], ["agent", "start"], ["agent", "prompt"], ["agent", "prompt"],
    ]  # fmt: skip
    assert len(splits) == len(closes) == 6
    assert [call[call.index("--pane") + 1] for call in starts] == [call[2] for call in closes]


def test_long_literal_goal_is_text():
    args = parser().parse_args(["campaign", "run", "--repo", "/x", "--goal", "a" * 300])
    assert campaign.inputs(args)["goal"] == "a" * 300


def test_campaign_fails_before_any_stage_when_a_skill_is_missing(repository, pi, tmp_path):
    subprocess.run(["git", "rm", "-rq", ".agents/skills/ponytail"], cwd=repository, check=True)
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "drop"],
        cwd=repository,
        check=True,
    )
    workflow = campaign.Workflow(command=str(pi))
    with pytest.raises(RuntimeError, match="Pi skills not installed: ponytail"):
        workflow(goal="g", repository=str(repository), run_dir=str(tmp_path / "run"))
    assert not Path(os.environ["FAKE_PI_LOG"]).exists()


def test_evidence_brief_inlines_only_the_end_of_failing_check_output(tmp_path):
    passing, failing = tmp_path / "ok.log", tmp_path / "bad.log"
    passing.write_text("all green\n")
    failing.write_text("collected\n" + "." * 5000 + "\nassert 1 == 2\n")
    text = "\n".join(campaign.evidence_brief({
        "error": None, "diff": str(tmp_path / "diff.patch"), "workflow_review": None, "review": None,
        "checks": [
            {"command": "true", "exit_code": 0, "output": str(passing)},
            {"command": "pytest", "exit_code": 1, "output": str(failing)},
        ],
    }))  # fmt: skip
    assert str(passing) in text and "all green" not in text
    assert "assert 1 == 2" in text and "collected" not in text
    assert "earlier characters omitted" in text


def test_verify_rejects_a_diff_over_the_evaluator_limit(repository, tmp_path, monkeypatch):
    monkeypatch.setattr(campaign, "DIFF_LIMIT", 100)
    (repository / "generated.txt").write_text("x" * 200)
    state = campaign.State(
        goal="g", repository=str(repository), base_commit="HEAD", worktree=str(repository),
        constraints=[], authority=campaign.LOCAL_AUTHORITY,
        acceptance={"criteria": ["c"], "commands": ["true"]},
    )  # fmt: skip
    evidence = campaign.verify(state, tmp_path / "verification", None, campaign.EVALUATOR)
    assert "over the evaluator's limit of 100" in evidence["error"]
    assert evidence["review"] is None


def test_metric_scores_evidence():
    passed = dspy.Prediction(
        status="completed",
        result="ok",
        evidence={"error": None, "checks": [], "review": {**campaign.Review(
            completeness=True, correctness=True, maintainability=True, findings="fine"
        ).model_dump()}},
    )  # fmt: skip
    assert campaign.metric(None, passed).score == 1.0
    rejected = dspy.Prediction(status="failed", result="r", evidence=passed.evidence)
    assert campaign.metric(None, rejected).score == 0.0
    assert "workflow ended failed" in campaign.metric(None, rejected).feedback
    blocked = dspy.Prediction(status="blocked", result="Ambiguous goal", evidence=None)
    assert campaign.metric(None, blocked).feedback == "Ambiguous goal"


def test_saved_program_restores_learned_instructions(tmp_path):
    workflow = campaign.Workflow()
    workflow.review.signature = workflow.review.signature.with_instructions("Be strict.")
    workflow.save(tmp_path / "program.json")
    loaded = campaign.Workflow()
    loaded.load(tmp_path / "program.json")
    assert loaded.review.signature.instructions == "Be strict."
    assert loaded.plan.signature.instructions == campaign.PlanStage.instructions


def test_cli_run_reports_result(repository, pi, tmp_path, capsys, monkeypatch):
    goal = tmp_path / "goal.md"
    goal.write_text("Finish source.txt\n")
    # Inside Herdr the CLI would open panes; --headless keeps `pi --mode json`.
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setenv("HERDR_PANE_ID", "w1:p1")
    code = main(
        ["campaign", "run", "--headless", "--pi", str(pi), "--repo", str(repository),
         "--goal", str(goal), "--run-dir", str(tmp_path / "run")]
    )  # fmt: skip
    assert code == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "completed"
    assert "Finish source.txt\n" in calls()[0]["prompt"]


def test_cli_optimize_rejects_an_unknown_split(tmp_path):
    cases = tmp_path / "cases.json"
    cases.write_text(json.dumps([{"goal": "g", "repository": "/x", "split": "test"}]))
    with pytest.raises(ValueError, match="Unknown split 'test'"):
        main(["campaign", "optimize", "--cases", str(cases), "--out", str(tmp_path / "p.json")])
    assert not (tmp_path / "p.json").exists()
