# LearnHarness — Side Tutor fork

This is a fork of amosblomqvist/learnharness. All fork work lives on the `side-tutor` branch and ships as a separate Windows app, "LearnHarness Side Tutor".

@AGENTS.md
@docs/side-tutor.md

## Working here

- Follow AGENTS.md: investigate, ask about design decisions, and get the plan approved before implementing.
- Tests: `npm test` (all), or `NODE_ENV=test npx tsx --test tests/<file>.test.ts`. Also `npm run typecheck` and `npm run lint`.
- **Every push to `side-tutor` publishes a release** that installed apps download automatically. Pushes that only change `CLAUDE.md` or `docs/` don't build.
- Keep this file and `docs/side-tutor.md` technical. The fork is public: no personal information.
