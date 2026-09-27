"""The Pi prompt templates in `prompts/`, and the DSPy adapter that sends them as written.

Each template is the instructions of one predictor. Its inputs replace `$@`, the place Pi fills
with arguments when the template runs by hand. The reply is the output, as plain text.
"""

from pathlib import Path
from typing import Literal, get_args, get_origin

import dspy

DIRECTORY = Path(__file__).parents[2] / "prompts"


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
    """One user message in, the whole reply out.

    A `History` input is not sent: the Pi session already holds those turns. A `Literal` output is
    the reply's last line, asked for with the field's `desc`, or None when that line is not one of
    its values.
    """

    def format(self, signature, demos, inputs):
        sent = {
            name: value for name, value in inputs.items() if not isinstance(value, dspy.History)
        }
        endings = [
            f"End with one line: {field.json_schema_extra['desc']}."
            for field in signature.output_fields.values()
            if get_origin(field.annotation) is Literal
        ]
        return [
            {
                "role": "user",
                "content": "\n\n".join([render(signature.instructions, sent), *endings]),
            }
        ]

    def parse(self, signature, completion):
        text = completion.strip()
        (first, *rest) = signature.output_fields
        last = text.splitlines()[-1].strip("*`. ") if text else ""
        choices = {name: get_args(signature.output_fields[name].annotation) for name in rest}
        return {first: text} | {name: last for name, values in choices.items() if last in values}
