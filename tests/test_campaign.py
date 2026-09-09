import json
import os
import subprocess
import sys
from pathlib import Path

import dspy
import pytest

from workflows.cli import main
from workflows.workflows import campaign

FAKE_PI = Path(__file__).with_name("fake_pi.py")


@pytest.fixture
def repository(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    (repo / "README.md").write_text("hello\n")
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
    return script


def calls():
    return json.loads(Path(os.environ["FAKE_PI_LOG"]).read_text())


def test_campaign_runs_plan_implement_review_fix_review_in_fresh_sessions(repository, pi, tmp_path):
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


def test_cli_run_reports_result(repository, pi, tmp_path, capsys):
    goal = tmp_path / "goal.md"
    goal.write_text("Finish source.txt\n")
    code = main(
        ["run:campaign", "--pi", str(pi), "--repo", str(repository), "--goal", str(goal),
         "--run-dir", str(tmp_path / "run")]
    )  # fmt: skip
    assert code == 0
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "completed"
    assert "Finish source.txt\n" in calls()[0]["prompt"]
