"""`workflows ship` ships one markdown work item onto a new branch through Pi.
`workflows optimize` improves the ship prompts in `prompts/` with GEPA, scoring rollouts of work
items with the judge."""

import argparse
import os
import sys
from pathlib import Path

from workflows.optimize import optimize
from workflows.ship import run_directory, ship


def positive(value: str) -> int:
    if not value.isdecimal() or int(value) < 1:
        raise argparse.ArgumentTypeError(f"{value!r} is not a positive integer")
    return int(value)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="workflows", description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    shipping = commands.add_parser("ship", help="Ship a work item onto a new branch")
    optimizing = commands.add_parser("optimize", help="Improve the ship prompts with GEPA")
    for command in (shipping, optimizing):
        command.add_argument("--repo", required=True, help="Absolute repository path")
        command.add_argument("--base", default="main", help="Ref the run starts from")
        command.add_argument("--rounds", type=positive, default=3, help="Maximum rounds per item")
        command.add_argument("--pi", default="pi", help="Pi executable")
        command.add_argument(
            "--headless",
            action="store_true",
            help="Run sessions with `pi --mode json` even inside Herdr (default: visible panes)",
        )
        command.add_argument("--run-dir", help="Run directory (default under $XDG_STATE_HOME)")
    shipping.add_argument("item", type=Path, help="Markdown work item file")
    optimizing.add_argument("items", type=Path, nargs="+", help="Markdown work item files")
    optimizing.add_argument(
        "--budget", type=positive, required=True, help="Rollouts GEPA may spend (its metric calls)"
    )
    return root


def herdr_pane(args) -> str | None:
    if args.headless or os.environ.get("HERDR_ENV") != "1":
        return None
    return os.environ.get("HERDR_PANE_ID") or None


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    run = Path(args.run_dir) if args.run_dir else run_directory()
    print(f"run directory: {run}", file=sys.stderr)
    herdr = herdr_pane(args)
    if args.command == "optimize":
        optimize(args.repo, args.base, args.items, run, args.budget, args.rounds, args.pi, herdr)
        return 0
    shipped = ship(args.repo, args.base, args.item, run, args.rounds, args.pi, herdr)
    return 0 if shipped else 1


if __name__ == "__main__":
    sys.exit(main())
