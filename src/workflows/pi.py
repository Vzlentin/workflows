"""Pi as a DSPy language model.

Every LM call is one turn of a Pi session. A fresh session runs headlessly as `pi --mode json`
with the prompt on stdin, or, inside Herdr, as a visible `pi` agent in a new pane. The final
assistant message of the turn is the LM response.
"""

import json
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

import dspy
from dspy.core.types import LMOutput, LMRequest, LMResponse, LMTextPart

REPAIR_PROMPT = (
    "Your previous reply did not contain the required JSON object. "
    "Reply with only that JSON object, following the field structure from the instructions."
)


@dataclass(frozen=True)
class Agent:
    """How Pi starts for one kind of session. Without tools it is a plain model call."""

    model: str
    thinking: str = "medium"
    tools: tuple[str, ...] = ()
    skill: str | None = None

    def arguments(self) -> list[str]:
        # Extensions stay on: providers such as `cursor` are installed as extension packages.
        args = ["--model", self.model, "--thinking", self.thinking]
        if self.tools:
            return [*args, "--tools", ",".join(self.tools)]
        return [*args, "--no-tools", "--no-context-files", "--no-skills"]


def skill_name(path: Path) -> str:
    """The frontmatter `name`, or the parent directory name as Pi falls back to."""
    lines = path.read_text(errors="replace").splitlines()
    if lines and lines[0].strip() == "---":
        for line in lines[1:]:
            if line.strip() == "---":
                break
            key, _, value = line.partition(":")
            if key.strip() == "name" and value.strip():
                return value.strip().strip("'\"")
    return path.parent.name


def installed_skills(cwd: Path) -> set[str]:
    """Names of the skills Pi discovers for a session in `cwd`, so `/skill:name` will expand.

    Covers `SKILL.md` directories in the user and project skill locations, not single-file
    skills or skills added by settings or packages.
    """
    home = Path.home()
    roots = (
        home / ".pi" / "agent" / "skills",
        home / ".agents" / "skills",
        cwd / ".pi" / "skills",
        cwd / ".agents" / "skills",
    )
    return {skill_name(path) for root in roots for path in root.rglob("SKILL.md")}


def assistant_text(message: dict) -> str:
    if message.get("stopReason") in ("error", "aborted"):
        raise RuntimeError(message.get("errorMessage") or f"Pi session {message['stopReason']}")
    return "".join(part.get("text", "") for part in message["content"] if part["type"] == "text")


def last_assistant(messages: list[dict]) -> str:
    assistants = [message for message in messages if message.get("role") == "assistant"]
    if not assistants:
        raise RuntimeError("Pi session ended without an assistant message")
    return assistant_text(assistants[-1]).strip()


def transcript(directory: Path) -> list[dict]:
    files = sorted(directory.glob("*.jsonl"))
    if not files:
        raise RuntimeError(f"Pi session produced no transcript in {directory}")
    entries = [json.loads(line) for line in files[-1].read_text().splitlines() if line.strip()]
    return [entry["message"] for entry in entries if entry.get("type") == "message"]


class Pi:
    """Opens Pi sessions for one run. Transcripts and prompts live under `directory/<label>/`."""

    def __init__(self, directory: Path, cwd: Path, command: str = "pi", herdr: str | None = None):
        self.directory = Path(directory)
        self.cwd = Path(cwd)
        self.command = command
        # With a Herdr pane id, that pane is split and each session is a visible agent beside it.
        self.herdr = herdr
        self.counts: dict[str, int] = {}

    def open(self, agent: Agent, label: str) -> "Session":
        self.counts[label] = self.counts.get(label, 0) + 1
        directory = self.directory / f"{label}-{self.counts[label]}"
        directory.mkdir(parents=True, exist_ok=True)
        return Session(self, agent, directory)


class Session:
    """One Pi session. The first prompt opens it; later prompts continue the same transcript."""

    def __init__(self, pi: Pi, agent: Agent, directory: Path):
        self.pi = pi
        self.agent = agent
        self.directory = directory
        self.id: str | None = None
        self.name: str | None = None
        self.pane: str | None = None
        self.turn = 0

    def prompt(self, text: str) -> str:
        self.turn += 1
        (self.directory / f"prompt-{self.turn}.md").write_text(text)
        if self.pi.herdr:
            return self.prompt_herdr(text)
        return self.prompt_headless(text)

    def prompt_headless(self, text: str) -> str:
        args = [self.pi.command, "--mode", "json", "--session-dir", str(self.directory)]
        args += self.agent.arguments()
        if self.id:
            args += ["--session", self.id]
        result = subprocess.run(
            args, input=text, capture_output=True, text=True, cwd=self.pi.cwd, check=False
        )
        with (self.directory / "pi.log").open("a") as log:
            log.write(result.stderr)
        messages = []
        for line in result.stdout.splitlines():
            if not line.startswith("{"):
                continue
            event = json.loads(line)
            if event.get("type") == "session":
                self.id = event["id"]
            elif event.get("type") == "message_end":
                messages.append(event["message"])
        if result.returncode != 0 and not messages:
            raise RuntimeError(f"pi exited with {result.returncode}: {result.stderr.strip()}")
        return last_assistant(messages)

    def herdr(self, *args: str) -> dict:
        result = subprocess.run(
            ["herdr", *args], capture_output=True, text=True, cwd=self.pi.cwd, check=False
        )
        if result.returncode != 0:
            raise RuntimeError(f"herdr {' '.join(args[:2])} failed: {result.stdout}{result.stderr}")
        return json.loads(result.stdout.strip().splitlines()[-1])

    def prompt_herdr(self, text: str) -> str:
        if not self.name:
            split = self.herdr(
                "pane", "split", "--pane", self.pi.herdr, "--direction", "right",
                "--cwd", str(self.pi.cwd), "--no-focus",
            )  # fmt: skip
            self.pane = split["result"]["pane"]["pane_id"]
            self.name = f"{self.directory.name}-{uuid.uuid4().hex[:4]}"
            self.herdr(
                "agent", "start", self.name, "--kind", "pi", "--pane", self.pane,
                "--timeout", "120000", "--", "--session-dir", str(self.directory),
                *self.agent.arguments(),
            )  # fmt: skip
        self.herdr("agent", "prompt", self.name, text, "--wait")
        return last_assistant(transcript(self.directory))

    def close(self) -> None:
        if self.pane:
            self.herdr("pane", "close", self.pane)
            self.pane = self.name = None


def flatten(request: LMRequest) -> str:
    """Pi keeps its own system prompt, so DSPy's system text and demos lead the user prompt."""
    messages = []
    for message in request.messages:
        if any(not isinstance(part, LMTextPart) for part in message.parts):
            raise ValueError("Pi sessions accept text inputs only")
        messages.append((message.role, "".join(part.text for part in message.parts)))
    *context, (role, prompt) = messages
    if role != "user":
        raise ValueError("A Pi prompt must end with a user message")
    preamble = [
        content if role == "system" else f"Example {role} message:\n{content}"
        for role, content in context
    ]
    return "\n\n".join([*preamble, prompt])


class PiLM(dspy.BaseLM):
    """Each call opens a fresh Pi session, unless `repair` asks the open session for its JSON."""

    forward_contract = "typed_lm"

    def __init__(self, pi: Pi, agent: Agent, label: str, preamble: str = ""):
        super().__init__(model=f"pi/{agent.model}", cache=False, num_retries=0)
        self.pi = pi
        self.agent = agent
        self.label = label
        self.preamble = preamble
        self.session: Session | None = None
        self.repair = False

    def forward(self, request: LMRequest) -> LMResponse:
        if self.repair and self.session:
            prompt = REPAIR_PROMPT
        else:
            if self.session:
                self.session.close()
            self.session = self.pi.open(self.agent, self.label)
            prompt = "\n\n".join(part for part in (self.preamble, flatten(request)) if part)
            # Pi expands a leading `/skill:name` into the user's installed skill body.
            if self.agent.skill:
                prompt = f"/skill:{self.agent.skill} {prompt}"
        text = self.session.prompt(prompt)
        return LMResponse(
            model=self.model,
            outputs=[LMOutput(parts=[LMTextPart(text=text)], finish_reason="stop")],
        )

    def close(self) -> None:
        if self.session:
            self.session.close()
