"""`workflows ship`: ship markdown work items, in order, onto a new branch through Pi."""

import argparse
import os
import sys
from pathlib import Path

from workflows.ship import run_directory, ship


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="workflows", description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    command = commands.add_parser("ship", help="Ship work items, in order, onto a new branch")
    command.add_argument("--repo", required=True, help="Absolute repository path")
    command.add_argument("--base", default="main", help="Ref the branch starts from")
    command.add_argument("--rounds", type=int, default=3, help="Maximum rounds per item")
    command.add_argument("--pi", default="pi", help="Pi executable")
    command.add_argument(
        "--headless",
        action="store_true",
        help="Run sessions with `pi --mode json` even inside Herdr (default: visible Herdr panes)",
    )
    command.add_argument("--run-dir", help="Run directory (default under $XDG_STATE_HOME)")
    command.add_argument("items", nargs="+", metavar="ITEM", help="Markdown work item file")
    return root


def herdr_pane(args) -> str | None:
    if args.headless or os.environ.get("HERDR_ENV") != "1":
        return None
    return os.environ.get("HERDR_PANE_ID") or None


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    directory = Path(args.run_dir) if args.run_dir else run_directory()
    print(f"run directory: {directory}", file=sys.stderr)
    items = [Path(item) for item in args.items]
    shipped = ship(args.repo, args.base, items, directory, args.rounds, args.pi, herdr_pane(args))
    return 0 if shipped else 1


if __name__ == "__main__":
    sys.exit(main())
