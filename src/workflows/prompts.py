"""The Pi prompt templates in `prompts/`, and the DSPy adapter that sends them as written.

Each template is the instructions of one predictor, then a last line `$@`, where Pi puts the
arguments when the template runs by hand. The engine drops that line and sends the inputs after
the instructions. The reply is the output, as plain text, except the endings the engine parses.
"""

import json
import re
from pathlib import Path
from typing import Literal, get_args, get_origin

import dspy

DIRECTORY = Path(__file__).parents[2] / "prompts"
# A JSON string holds no raw newline, so only the closing fence starts a line with ```.
FENCE = re.compile(r"^```json[ \t]*\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)
OPENING = re.compile(r"^```json[ \t]*$", re.MULTILINE)


def load(name: str) -> str:
    """The instructions of `prompts/<name>.md`: its body without frontmatter or the last `$@`."""
    text = (DIRECTORY / f"{name}.md").read_text()
    if text.startswith("---\n"):
        text = text.partition("\n---\n")[2]
    return text.strip().removesuffix("$@").strip()


def save(name: str, instructions: str) -> None:
    """Rewrite the body of `prompts/<name>.md`, keeping its frontmatter and the last `$@`, so that
    `load(name)` returns `instructions` stripped."""
    path = DIRECTORY / f"{name}.md"
    frontmatter, separator, _ = path.read_text().partition("\n---\n")
    path.write_text(f"{frontmatter}{separator}{instructions.strip()}\n\n$@\n")


def render(body: str, inputs: dict[str, str]) -> str:
    values = {name: value.strip() for name, value in inputs.items()}
    return "\n\n".join([body, *(f"## {name}\n{value}" for name, value in values.items() if value)])


def strings(reply: str) -> list[str]:
    """The last fenced `json` block of `reply` as a list of non-blank strings.

    Raises `RuntimeError` with the reply when that block is missing, unclosed or holds anything
    else.
    """
    openings = [match.start() for match in OPENING.finditer(reply)]
    block = FENCE.match(reply, openings[-1]) if openings else None
    try:
        value = json.loads(block[1]) if block else None
    except json.JSONDecodeError:
        value = None
    if not isinstance(value, list) or not all(isinstance(s, str) and s.strip() for s in value):
        raise RuntimeError(f"reply has no last fenced json array of non-blank strings:\n{reply}")
    return value


class Template(dspy.Adapter):
    """One user message in, the whole reply out.

    A `History` input is not sent: the Pi session already holds those turns. A `Literal` output is
    the reply's last line, asked for with the field's `desc`, or None when that line is not one of
    its values. A `list[str]` output is the reply's last fenced `json` array, asked for with the
    field's `desc`. Any other output is the whole reply.
    """

    def format(self, signature, demos, inputs):
        sent = {
            name: value for name, value in inputs.items() if not isinstance(value, dspy.History)
        }
        endings = []
        for field in signature.output_fields.values():
            if get_origin(field.annotation) is Literal:
                endings.append(f"End with one line: {field.json_schema_extra['desc']}.")
            elif field.annotation == list[str]:
                endings.append(f"End with {field.json_schema_extra['desc']}.")
        return [
            {
                "role": "user",
                "content": "\n\n".join([render(signature.instructions, sent), *endings]),
            }
        ]

    def parse(self, signature, completion):
        text = completion.strip()
        last = text.splitlines()[-1].strip("*`. ") if text else ""
        values = {}
        for name, field in signature.output_fields.items():
            if get_origin(field.annotation) is Literal:
                if last in get_args(field.annotation):
                    values[name] = last
            elif field.annotation == list[str]:
                values[name] = strings(text)
            else:
                values[name] = text
        return values
