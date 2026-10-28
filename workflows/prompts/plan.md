---
description: Investigate a change and write its contract
argument-hint: "<work item>"
---
Plan this change.

## Investigate

Start from the research document below: it describes the code as it is today. Read the code that the plan relies on, and trace the real execution path before planning. For bugs, prefer a real user-path reproduction, then an existing integration signal, then an owning-layer test. If none is available, label the diagnosis as a hypothesis. For features, define one observable acceptance signal.

Separate facts from assumptions. Check each fact that the plan relies on in the code, and check that each proof fails on the code as it is today. Reuse what the codebase already has before you plan new code. Investigation cannot expand the request.

## Present the contract

Give one short, plain-language brief:

**Problem:** what is changing and the evidence.

**Contract:** required observable behavior.

**Protected behavior:** existing behavior that must not regress.

**Non-goals:** adjacent work that will not be implemented.

**Proof:** fail-before/pass-after signal and repository checks.

Keep it to one screen when practical. Use requirement IDs only when they prevent real ambiguity.

$@
