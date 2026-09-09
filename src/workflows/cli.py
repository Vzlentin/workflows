"""`workflows`: run a DSPy workflow through Pi, or optimize it with GEPA."""

import argparse
import json
import os
import sys
from pathlib import Path

import dspy

from workflows.pi import Agent, Pi, PiLM
from workflows.workflows import REGISTRY
from workflows.workflows.campaign import run_directory


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="workflows", description=__doc__)
    commands = root.add_subparsers(dest="action", required=True)
    commands.add_parser("list", help="List workflows")
    for name, module in REGISTRY.items():
        run = commands.add_parser(f"run:{name}", help=f"Run the {name} workflow")
        common(run)
        module.arguments(run)
        optimize = commands.add_parser(f"optimize:{name}", help=f"Optimize {name} with GEPA")
        common(optimize)
        optimize.add_argument("--cases", required=True, help="JSON list of cases (input fields)")
        optimize.add_argument("--out", required=True, help="Where to save the optimized program")
        optimize.add_argument("--max-metric-calls", type=int, default=6)
        optimize.add_argument("--reflection-model", default="openai-codex/gpt-6-astra")
        optimize.add_argument("--reflection-thinking", default="high")
    return root


def common(command: argparse.ArgumentParser) -> None:
    command.add_argument("--program", help="Saved program state to load (from optimize)")
    command.add_argument("--run-dir", help="Run directory (default under $XDG_STATE_HOME)")
    command.add_argument("--pi", default="pi", help="Pi executable")
    command.add_argument("--rounds", type=int, default=3, help="Maximum review rounds")
    command.add_argument(
        "--herdr",
        action="store_true",
        help="Run stage sessions as visible Pi agents in Herdr panes beside this one",
    )


def build(module, args) -> dspy.Module:
    program = module.Workflow(rounds=args.rounds, command=args.pi, herdr=herdr_pane(args))
    if args.program:
        program.load(args.program)
    return program


def herdr_pane(args) -> str | None:
    if not args.herdr:
        return None
    if os.environ.get("HERDR_ENV") != "1" or not os.environ.get("HERDR_PANE_ID"):
        raise SystemExit("--herdr requires running inside Herdr (HERDR_ENV=1, HERDR_PANE_ID)")
    return os.environ["HERDR_PANE_ID"]


def run(module, args) -> int:
    program = build(module, args)
    run_dir = Path(args.run_dir) if args.run_dir else run_directory()
    print(f"run directory: {run_dir}", file=sys.stderr)
    prediction = program(**module.inputs(args), run_dir=str(run_dir))
    print(json.dumps(dict(prediction.items()), indent=2, default=str))
    return 0 if prediction.status == "completed" else 1


def optimize(module, args) -> int:
    program = build(module, args)
    run_dir = Path(args.run_dir) if args.run_dir else run_directory()
    run_dir.mkdir(parents=True, exist_ok=True)
    print(f"run directory: {run_dir}", file=sys.stderr)
    cases = json.loads(Path(args.cases).read_text())
    examples = {"train": [], "val": []}
    for case in cases:
        split = case.pop("split", "train")
        examples[split].append(dspy.Example(**case).with_inputs(*module.INPUTS))
    reflection = PiLM(
        Pi(run_dir / "reflection", run_dir, args.pi),
        Agent(args.reflection_model, args.reflection_thinking),
        "reflection",
    )
    # Each case's forward() creates its own run directory under XDG state.
    gepa = dspy.GEPA(
        metric=module.metric,
        max_metric_calls=args.max_metric_calls,
        reflection_lm=reflection,
        reflection_minibatch_size=1,
        num_threads=1,
        log_dir=str(run_dir / "gepa"),
        track_stats=True,
    )
    optimized = gepa.compile(program, trainset=examples["train"], valset=examples["val"] or None)
    optimized.save(args.out)
    for name, predictor in optimized.named_predictors():
        print(f"## {name}\n{predictor.signature.instructions}\n")
    print(f"saved {args.out}", file=sys.stderr)
    return 0


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.action == "list":
        for name, module in REGISTRY.items():
            print(f"{name}: {module.__doc__.strip().splitlines()[0]}")
        return 0
    action, name = args.action.split(":")
    module = REGISTRY[name]
    return run(module, args) if action == "run" else optimize(module, args)


if __name__ == "__main__":
    sys.exit(main())
