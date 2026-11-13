# LearnHarness — Side Tutor fork

This is a fork of amosblomqvist/learnharness. All fork work lives on the `side-tutor` branch and ships as a separate Windows app, "LearnHarness Side Tutor".

@AGENTS.md
@docs/side-tutor.md
@docs/cloud-sync.md
@docs/upstream-0.6.0.md

## Working here

- Follow AGENTS.md: investigate, ask about design decisions, and get the plan approved before implementing.
- After `npm ci`, run `npm run plugins:setup` (upstream 0.6.0's core plugins); the build and several tests need it.
- Tests: `npm test` (all), or `NODE_ENV=test npx tsx --test tests/<file>.test.ts`. Also `npm run typecheck` and `npm run lint`.
- **Every push to `side-tutor` publishes a release** that installed apps download automatically, and needs the owner's approval every time. Pushes that only change `CLAUDE.md` or `docs/` don't build. Any other push builds, `.claude/` included, unless its commit message carries `[skip ci]`.
- **Two branches feed two things:** `side-tutor` feeds the Windows app (and the server image `:latest`); the owner's server follows the image `:dev`, built from `claude/pensive-goldberg-7dty2m`. A change both should get goes to both branches, kept at the same commit. See "After the merge" under "Handoff" in `docs/cloud-sync.md`.
- **The desktop app and the server must speak the same sync protocol version** (3 now). A change that raises it has to reach both, the server first, or sync pauses.
- What is built, the owner's decisions and what is still open are in the docs, not here: `docs/side-tutor.md` (the Tutor, the notes drawer, the Windows app), `docs/cloud-sync.md` (the server, phone and tablet layouts, sync) and `docs/upstream-0.6.0.md` (the 0.6.0 merge and what came after it). Change a recorded decision only with the owner's approval.
- Keep this file, `docs/side-tutor.md`, `docs/cloud-sync.md` and `docs/upstream-0.6.0.md` technical. The fork is public: no personal information.

## Fable orchestration policy — Option B (selective reviews)

When the lead model is Fable, use it as architect, planner, dispatcher, and final integrator. Workers do the bulk of code reading, writing, testing, and routine reviewing. Never assume a worker should inherit the Fable model.

### User design-decision approval gate (mandatory)

Fable is the planner and recommender, **not the final authority over unspecified product/design decisions**. Before delegating implementation, inspect the user's request, existing project documentation, current UX, architecture and conventions. Distinguish established requirements from meaningful unresolved choices.

**Ask the user before implementation when a choice is material and no existing specification settles it.** Examples: user-visible behavior or workflows, layout/navigation direction, UX tradeoffs, feature scope, external integrations/providers, persistent data models, breaking public contracts, security/privacy policies, irreversible or costly changes, and substantial architectural tradeoffs. Proactively ask about a consequential design choice even when the user did not explicitly request a design discussion.

**Decide autonomously** on routine, low-impact, easily reversible implementation details that follow established conventions (variable naming, localized refactors, tests, minor styling, small internal helpers). Do not interrupt for decisions already answered by the user or unambiguously documented. A request to "use your judgment" grants discretion for ordinary choices; do not treat it as approval for destructive, security-critical, or other high-consequence choices.

When clarification is needed:
1. Ask **before spawning implementers for the affected work**. If useful, first delegate read-only exploration to establish the actual options.
2. Ask **one question per call**: never batch several decisions into one checkpoint. When more than one decision is open, ask them one after another, the most blocking first. For each, explain the decision, give 2–3 concrete options and their relevant tradeoffs, state a recommended option with reasons, and explicitly request the user's choice. Use Claude Code's interactive question capability when available; otherwise ask in chat.
3. Label these questions `USER DECISION REQUIRED`. **Never silently choose your recommended option, treat silence as approval, or have a subagent make the choice on the user's behalf.** If waiting for a reply, stop work dependent on that decision; independent read-only work or unrelated approved implementation may proceed.
4. Record decisions and constraints in the active plan/handoff. For long-running projects, update a suitable existing project decision or planning document if one exists; avoid creating redundant documentation. Pass the approved decision and acceptance criteria to every affected worker.
5. If implementation reveals a new material option, conflicting requirements, or a necessary departure from an approved decision, pause the affected work and ask again, rather than quietly revising the design. In final reports, distinguish approved choices from unresolved choices.

**Approval boundaries:** Answering the design questions is not approval to build. **Present the implementation plan and get the user's approval of it before any implementation starts**, as AGENTS.md requires. Once the plan is approved, Fable may execute it without asking permission for every ordinary implementation step. Never claim an instruction-only gate is a technical guarantee of approval.

### Before delegation

1. Clarify goals, constraints, acceptance criteria and important interfaces from project context. Apply the **user design-decision approval gate** above and resolve blocking decisions before starting affected implementation. Prepare a concise plan and get it approved by the user before delegating any implementation.
2. Decompose into bounded tasks with exclusive file ownership. List dependencies, test commands, risk (low / moderate / high), and recommended worker model/effort.
3. Use **up to five concurrent subagents**, not always five. Launch only genuinely independent tasks simultaneously; dependent tasks run in sequence. For a small task, use one worker or handle directly.
4. For each Agent invocation, specify the agent type, model and effort explicitly; do not use `inherit` and do not spawn a general-purpose Fable worker accidentally. Read `/tasks` to confirm actual models.
5. No worker may create another agent. Do not spawn an agent team unless explicitly requested; ordinary subagents are the default.

### Model router

- `Explore` / Haiku medium: focused repository searches, file discovery, small fact extraction. Summarize relevant paths and evidence; do not copy entire files back.
- `routine-implementer` / Sonnet medium: well-specified code changes, small features, API integrations, test fixes. Promote to Sonnet high for moderately ambiguous work.
- `complex-implementer` / Opus high: difficult algorithmic work, debugging multiple components, migrations, tricky architecture-sensitive implementation. Do not use for routine formatting or boilerplate.
- `test-verifier` / Sonnet medium: run targeted tests, check acceptance criteria, inspect the relevant diff, independently identify reproducible issues. No code edits.
- `deep-reviewer` / Opus high: only high-risk or cross-cutting changes (authentication, money, sensitive data, migrations, concurrency, security), or unresolved substantive concerns. Read-only review.
- `performance-analyst` / Opus high: performance audits and optimization planning: bottleneck analysis, profiling evidence, non-destructive diagnostics, ranked recommendations. No code edits.
- Fable high: architectural planning and final integration; escalate to Fable's own detailed review only for critical or ambiguous unresolved risk, and preferably once per milestone rather than per commit.

### Execution contract

For every delegated task, provide: goal; assigned files/modules; context and interface contracts; definition of done; tests; constraints; expected output. Parallel writers must not edit the same files. If ownership conflicts, run tasks sequentially, or explicitly isolate and merge them with Git worktrees.

Each worker's reply should be at most ~300 words unless requested otherwise:
- Outcome: complete / partial / blocked.
- Files changed, or files inspected.
- Tests and exact results (include command).
- Problems, risks, and unverified assumptions.
- Follow-up needed, if any.

### Selective Fable review — Option B

Fable MUST perform a concise integration assessment at each major milestone. A source-level Fable review is **conditional**: inspect focused actual diffs and evidence when the approved architecture or contract changed, cross-component integration is insufficiently tested, independent reviewers disagree about a material defect, or a security/data-integrity/irreversible decision needs lead-architect sign-off. Fable must not rubber-stamp worker summaries; verify the underlying evidence for important claims.

**Usage guardrail:** normally at most one Fable focused code review per milestone. A second review is allowed only if remediation introduces new material architecture risk or unresolved critical findings. Do not spend Fable tokens rereading the entire implementation after passing independent reviews. See `REVIEW_POLICY_OPTION_B.md` for triggers and the evidence handoff format.

### Review gates

1. The implementer must run relevant tests and provide proof, not only claim success.
2. Run an independent `test-verifier` after significant changes; cheap mechanical tests come before model reviews.
3. For routine changes with tests passing and no meaningful issues, accept without an Opus/Fable review.
4. For difficult or high-impact work, run `deep-reviewer` once on the diff and requirements. Do not make the original implementer its only reviewer.
5. At meaningful milestones, Fable assesses architecture and integration evidence. Conduct direct code review **only** when the Option B triggers above apply; otherwise synthesize concise worker reports and test results.
6. After two unsuccessful repair cycles, stop automatic retries and replan rather than adding agents indefinitely.

### Efficiency and reporting

Limit simultaneous agents to five. Default to two or three active implementation agents, scaling to five only when workstreams are truly independent. Avoid repeated repository-wide scans and long logs in Fable's context. Workers should return file paths, concise evidence, and verification results rather than bulk tool output. Review escalation should be based on risk, not on automatically invoking every reviewer. Avoid redundant Fable reviews after a passing independent review. Finish each milestone with status, verification, residual risks, and the agent/model assignments. Never claim an unrun test passed.

## Performance Investigation Mode

Activate this mode when the user asks to analyze,
profile, audit, or optimize application performance.

### Phase 1: Establish the baseline
- Identify the application architecture and runtime.
- Identify relevant performance metrics.
- Determine whether representative benchmarks,
  profiling tools, or production telemetry exist.
- Ask the user which performance outcomes matter
  when the objective is ambiguous.
- Do not modify application code during this phase.

### Phase 2: Investigate
- Delegate independent investigations when useful.
- Prefer analysis-focused agents for the audit: `performance-analyst`
  for bottleneck and profiling work, `Explore` for lightweight
  lookups. Implementation agents wait for Phase 5.
- Use Haiku for lightweight exploration and tooling.
- Use Sonnet for routine performance investigations.
- Use Opus for complex bottlenecks and concurrency.
- Avoid overlapping investigations.
- Run appropriate profiling or benchmarks when possible.
- Distinguish measured problems from hypotheses.

### Phase 3: Report findings
For each potential improvement, include:
- Problem and affected component
- Evidence and confidence level
- Expected performance benefit, if supportable
- Implementation difficulty
- Regression or compatibility risk
- Recommended priority

Rank improvements by expected impact,
confidence, effort, and risk.

### Phase 4: User approval
- Present the prioritized optimization plan.
- Ask the user which changes to implement.
- Do not implement consequential optimizations
  before receiving approval.
- Ask about tradeoffs affecting functionality,
  reliability, resource consumption, or UX.
- Proceed independently on routine investigation.

### Phase 5: Implementation and validation
After approval:
- Delegate implementation using existing agents.
- Measure performance before and after changes.
- Run regression tests.
- Use independent review proportional to risk.
- Escalate architectural concerns to Fable.
- Report actual improvements, remaining issues,
  and any limitations in the measurements.

Never present theoretical improvements as
measured performance gains.
