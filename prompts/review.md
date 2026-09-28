---
description: Strict code quality review of a change
argument-hint: "[scope]"
---
Perform a deep code quality audit of this change.

Report reproduced correctness bugs first. The plan is what this round implemented. After round 1, the decisions in that plan are settled: only unfinished fixes or regressions since the previous round can block.

Rethink how to structure / implement the change to meaningfully improve code quality without impacting behavior. Improve abstractions and modularity, reduce spaghetti code, improve succinctness and legibility. Be ambitious: if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it. Be extremely thorough and rigorous. Measure twice, cut once.

## Standards

0. **Be ambitious about structural simplification.** Look for the "code judo" move: a re-organization that uses the existing architecture more effectively so whole branches, helpers, modes, conditionals, or layers disappear. If you see a path to delete complexity rather than rearrange it, push hard for that path.
1. **Do not let a change push a file from under 1k lines to over 1k lines** without a very strong reason. Ask whether the code should be decomposed first.
2. **Do not allow random spaghetti growth in existing code.** New ad-hoc conditionals, scattered special cases, or one-off branches in unrelated flows are a design problem, not a nit.
3. **Bias toward cleaning the design, not just accepting working code.** Prefer simplifications that remove moving pieces over refactors that spread the same complexity around.
4. **Prefer direct, boring, maintainable code over hacky or magical code.** Flag thin abstractions, identity wrappers, and pass-through helpers that add indirection.
5. **Push hard on type and boundary cleanliness.** Question unnecessary optionality, `any`, casts, and silent fallbacks that paper over an unclear invariant.
6. **Keep logic in the canonical layer and reuse existing helpers.** Call out feature logic leaking into shared paths and bespoke one-offs next to a canonical utility.
7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells** when the cleaner structure is obvious.

## Primary questions

- Is there a "code judo" move that would make this dramatically simpler?
- Can this change be reframed so fewer concepts, branches, or helper layers are needed?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a previously cohesive module become more coupled, more stateful, or harder to scan?
- Is this logic living in the right file and layer?
- Are there repeated conditionals that signal a missing model or missing helper?
- Is this abstraction actually earning its keep, or is it just a wrapper?

## Output

Prioritize findings in this order:

1. Structural code-quality regressions
2. Missed opportunities for dramatic simplification / code-judo restructuring
3. Spaghetti / branching complexity increases
4. Boundary / abstraction / type-contract problems
5. File-size and decomposition concerns
6. Modularity, legibility and maintainability concerns

Do not flood the review with low-value nits if there are larger structural issues. Prefer a smaller number of high-conviction comments over a long list of cosmetic notes. Be direct, serious, and demanding about quality. Do not be rude, but do not soften major maintainability issues into mild suggestions.

## Approval bar

Do not approve merely because behavior seems correct. Treat these as presumptive blockers:

- a plausible code-judo move would delete a lot of preserved incidental complexity
- a file goes from below 1000 lines to above 1000 lines
- ad-hoc branching makes an existing flow more tangled
- feature checks are scattered across shared code
- an unnecessary abstraction, wrapper, or cast-heavy contract makes the design more indirect
- an existing helper is duplicated, or logic sits in the wrong layer

$@
