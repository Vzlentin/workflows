"""The Pi prompt templates in `prompts/`, and the DSPy adapter that sends them as written.

Each template is the instructions of one predictor. Its inputs replace `$@`, the place Pi fills
with arguments when the template runs by hand. The reply is the output, as plain text.
"""

from pathlib import Path
from typing import Literal, get_args, get_origin

import dspy

DIRECTORY = Path(__file__).parents[2] / "prompts"
VERDICT = "End with one line: SHIP if nothing needs to change, FIX otherwise."


def load(name: str) -> str:
    """The body of `prompts/<name>.md` without its frontmatter."""
    text = (DIRECTORY / f"{name}.md").read_text()
    if text.startswith("---\n"):
        text = text.partition("\n---\n")[2]
    return text.strip()


def render(body: str, inputs: dict[str, str]) -> str:
    values = {name: value.strip() for name, value in inputs.items()}
    sections = "\n\n".join(f"## {name}\n{value}" for name, value in values.items() if value)
    if "$@" in body:
        return body.replace("$@", sections)
    return "\n\n".join(part for part in (body, sections) if part)


class Template(dspy.Adapter):
    """One user message in, the whole reply out. A `Literal` output is the reply's last line."""

    def format(self, signature, demos, inputs):
        text = render(signature.instructions, inputs)
        if any(get_origin(f.annotation) is Literal for f in signature.output_fields.values()):
            text = f"{text}\n\n{VERDICT}"
        return [{"role": "user", "content": text}]

    def parse(self, signature, completion):
        text = completion.strip()
        (first, *rest) = signature.output_fields
        values = {first: text}
        last = text.splitlines()[-1].strip("*`. ") if text else ""
        for name in rest:
            # No repair turn: a missing verdict costs a round.
            values[name] = (
                last if last in get_args(signature.output_fields[name].annotation) else "FIX"
            )
        return values
