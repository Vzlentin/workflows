"""Workflow registry. Each module exposes `Workflow`, `metric`, `arguments`, and `inputs`."""

from workflows.workflows import campaign

REGISTRY = {"campaign": campaign}
