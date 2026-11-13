# Option B: Fable selective-review policy

**Operating mode:** Fable plans, orchestrates, integrates, and selectively reviews. Implementation and ordinary review are delegated. The project's `CLAUDE.md` is the executable behavioral policy; this file is an operator reference.

## Fable review decision rule

Perform a **focused Fable review** when at least one condition is true:

1. **Architecture moved:** The approved API contracts, data model, subsystem boundaries, dependency model, deployment or integration design changed during implementation.
2. **Cross-module integration risk:** Multiple subagents changed interacting components and tests do not adequately establish the end-to-end interface or failure behavior.
3. **Material unresolved finding:** The independent reviewer found a critical defect, or Opus/Sonnet reports conflict on correctness and the remaining uncertainty cannot be settled by a narrow test.
4. **High-consequence judgment:** Security/auth boundaries, destructive data migrations, financial or irreversible flows need a design-level approval beyond isolated code review.
5. **Meaningful milestone:** At a major milestone, Fable performs a **short integration assessment** of architecture and evidence. It reads underlying diff sections only if issues 1–4 are present or test coverage is insufficient.

Do **not** request a Fable source review for a routine patch solely because it is finished. Do not routinely re-review the full patch after a passing independent review.

## Cheap-first review ladder

- Gate 0 — Implementer: exact test commands/results, acceptance criteria checklist, changed-file summary.
- Gate 1 — Automation: focused unit/integration tests, lint, type checking, build or CI as relevant. Failures return to the responsible implementer.
- Gate 2 — Independent Sonnet verifier (medium): material feature changes, check requirements and integration, report reproducible findings; skip for trivial proven edits.
- Gate 3 — Independent Opus reviewer (high): difficult logic, security and data-integrity risks, complex cross-component interfaces.
- Gate 4 — Fable selective review (high): only for the decision rule above; focus on architecture and material issues, not style.

Gate 3 and Gate 4 are not mandatory for every task. For a critical design change, Fable's architecture sign-off and independent Opus code review may both be appropriate for **different questions**.

## Fable reviewer input contract

Before Fable considers direct review, obtain a compact evidence package:

- Approved plan and explicit acceptance criteria (links/paths preferred)
- Changed file list and narrow relevant diff sections
- Interfaces/contracts changed and reason
- Tests actually executed and exact outcomes
- Independent reviewer findings by severity, with evidence
- 1–3 precise questions that only the lead architect needs to answer

Avoid full logs, unrestricted repository sweeps, and entire diffs unless necessary to resolve a specific issue. Use the real source/diff to verify important claims, not only worker summaries.

**Review result:** `APPROVED`, `CHANGES REQUIRED`, or `INCONCLUSIVE`, with a concise rationale and bounded next steps. After remediation, verify the fixed issue with tests; request a second Fable review **only** if a material architectural concern remains.

## Concurrency, routing and limits

- Up to five concurrent subagents via the provided project settings; normally two or three implementation workers plus a focused scout or verifier when helpful.
- Haiku medium for exploration; Sonnet medium as standard implementer and verifier; Sonnet high by invocation when ambiguity warrants; Opus high for hard work and high-risk review.
- Independent workstreams only. No overlapping file edits without a specific integration/isolation plan.
- Review gates run after the relevant implementation is ready; do not spawn all reviewer agents before code exists.
- Use `/tasks` to confirm which subagents ran and which models they used. The concurrency setting limits parallel agent count; it is **not** a limit on model usage.
- Keep orchestration lean: avoid redundant agents, repeated full-context reviews, and uncontrolled repair loops.

## Definition of done

The work is complete when accepted deliverables exist, relevant tests have been **run** with results recorded, material independent review findings have been addressed or explicitly disclosed, and the lead's milestone assessment has passed. Report the actual models/effort used, remaining risks and any unverified work.
