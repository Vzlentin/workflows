`README.md` is the user contract for `workflows ship`. When a change alters the CLI, the commit
format, the run directory or the prompt contract, update the README in the same change.

- Read `CODING_STANDARDS.md` before you write or review code. Cite its rules by name.
- The implement and judge prompts run the checks listed here:
  `uv run ruff format --check src tests && uv run ruff check src tests && uv run pytest`.
  `uv run ruff format src tests` fixes formatting.
- Never verify with a real `pi`, `herdr` or `workflows ship`. They spend model calls and open
  panes, and inside a ship run `workflows ship` starts another run. The tests are the proof: when
  the engine needs a new Pi or Herdr behaviour, add it to `tests/fake_pi.py` or
  `tests/fake_herdr.py`.
- `prompts/*.md` are also interactive Pi commands. Keep their frontmatter, which the engine skips.
- `judge.verdict` parses the numbered answers of `prompts/judge.md` (1 and 2 gate the score,
  3 to 8 make it up). Change the questions and the parser together.
