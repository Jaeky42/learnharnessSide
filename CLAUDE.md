# LearnHarness — Side Tutor fork

This is a fork of amosblomqvist/learnharness. All fork work lives on the `side-tutor` branch and ships as a separate Windows app, "LearnHarness Side Tutor".

@AGENTS.md
@docs/side-tutor.md
@docs/cloud-sync.md

## Working here

- Follow AGENTS.md: investigate, ask about design decisions, and get the plan approved before implementing.
- Tests: `npm test` (all), or `NODE_ENV=test npx tsx --test tests/<file>.test.ts`. Also `npm run typecheck` and `npm run lint`.
- **Every push to `side-tutor` publishes a release** that installed apps download automatically. Pushes that only change `CLAUDE.md` or `docs/` don't build.
- Cloud sync (a phone and a server alongside the desktop app) is in progress on its own branch: see `docs/cloud-sync.md`, especially "Handoff".
- Keep this file, `docs/side-tutor.md` and `docs/cloud-sync.md` technical. The fork is public: no personal information.
