"""Pi sessions, and one open session as a DSPy language model.

A session runs headlessly as `pi --mode json` with each prompt on stdin, or, inside Herdr, as a
visible `pi` agent in a new pane. The final assistant message of a turn is the reply.
"""

import json
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import dspy
from dspy.core.types import LMOutput, LMRequest, LMResponse, LMTextPart

READ_ONLY = ("read", "grep", "find", "ls")


@dataclass(frozen=True)
class Agent:
    """How Pi starts for one kind of session."""

    model: str
    thinking: str
    tools: tuple[str, ...] | None

    def arguments(self) -> list[str]:
        # Extensions stay on: providers such as `cursor` are installed as extension packages.
        args = ["--model", self.model, "--thinking", self.thinking]
        if self.tools is not None:
            args += ["--tools", ",".join(self.tools)]
        return args


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
        # `agent start` answers agent_pane_busy whenever a new pane's shell has a startup command,
        # such as one from `.zshrc` or its prompt, in the foreground.
        for _ in range(60):
            result = subprocess.run(
                ["herdr", *args], capture_output=True, text=True, cwd=self.pi.cwd, check=False
            )
            if result.returncode == 0 or "agent_pane_busy" not in result.stdout + result.stderr:
                break
            time.sleep(1)
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


class SessionLM(dspy.BaseLM):
    """Each request's single user message is the next prompt of one open Pi session."""

    forward_contract = "typed_lm"

    def __init__(self, session: Session):
        super().__init__(model=f"pi/{session.agent.model}", cache=False, num_retries=0)
        self.session = session

    def forward(self, request: LMRequest) -> LMResponse:
        (message,) = request.messages
        text = self.session.prompt("".join(part.text for part in message.parts))
        return LMResponse(
            model=self.model,
            outputs=[LMOutput(parts=[LMTextPart(text=text)], finish_reason="stop")],
        )
