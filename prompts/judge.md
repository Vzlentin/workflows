---
description: Decide whether to merge one change, question by question
argument-hint: "<work item, base and head>"
---
## Vocabulary

**Module**: anything with an interface and an implementation, at any scale: a function, class,
package, or tier-spanning slice.

**Interface**: everything a caller must know to use the module correctly: the type signature,
but also invariants, ordering constraints, error modes, required configuration, and performance
characteristics.

**Implementation**: what's inside a module, its body of code.

**Depth**: leverage at the interface, the amount of behaviour a caller (or test) can exercise per
unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits
behind a small interface, **shallow** when the interface is nearly as complex as the
implementation.

**Seam**: a place where you can alter behaviour without editing in that place; the location at
which a module's interface lives.

**Adapter**: a concrete thing that satisfies an interface at a seam.

**Leverage**: what callers get from depth. **Locality**: what maintainers get from depth: change,
bugs, knowledge, and verification concentrate in one place rather than spreading across callers.

## Principles

- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a
  pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to
  test past the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a
  seam unless something actually varies across it.

## Rubric

You are deciding whether to merge one change. You did not write it.

$@

The worktree is at head. Read `git diff base head`, then the modules and callers it touches.
Run the checks listed in AGENTS.md. Rules: AGENTS.md, CONTEXT.md, docs/adr/ if present.
Judge only what this change did. Shallowness that already existed at base is not a finding.
A question fails only with evidence: file, line, and the rule it breaks. No evidence means PASS.

1. Complete: the change does everything the work item asks.
2. Correct: the checks pass and nothing is broken, in the diff or in its callers.
3. Scoped: every change is needed by the work item.
4. Earns its keep: every new module passes the deletion test.
5. Real seams: every new seam (protocol, base class, injected function, flag, mode) has two
   adapters in the tree.
6. Depth and locality: no touched module's interface grew without behaviour behind it, and the
   change sits in the module that owns the concept, not in its callers.
7. Test surface: new tests cross the module's interface; tests of replaced code are deleted.
8. Rules: no AGENTS.md rule is broken, new names use CONTEXT.md terms, no ADR is relitigated.

End with one line per question: `<n> PASS` or `<n> FAIL <file>:<line> <reason>`.
