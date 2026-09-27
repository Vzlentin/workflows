---
description: Investigate a change and write its contract
argument-hint: "<work item>"
---
Plan this change.

$@

## Investigate

Read repository instructions and trace the real execution path before planning.
For bugs, prefer a real user-path reproduction, then an existing integration
signal, then an owning-layer test. If none is available, label the diagnosis as
a hypothesis. For features, define one observable acceptance signal.

Separate facts from assumptions. Investigation cannot expand the request.

## Present the contract

Give one short, plain-language brief:

**Problem:** what is changing and the evidence.

**Contract:** required observable behavior.

**Protected behavior:** existing behavior that must not regress.

**Non-goals:** adjacent work that will not be implemented.

**Proof:** fail-before/pass-after signal and repository checks.

Keep it to one screen when practical. Use requirement IDs only when they prevent
real ambiguity.
