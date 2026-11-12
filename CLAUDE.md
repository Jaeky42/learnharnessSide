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
- **Every push to `side-tutor` publishes a release** that installed apps download automatically. Pushes that only change `CLAUDE.md` or `docs/` don't build.
- Cloud sync (a phone and a server alongside the desktop app) is built and merged into `side-tutor` (release 0.5.6): see `docs/cloud-sync.md`, especially "Handoff". The server's image is still built from its own branch; "After the merge" there says which branch changes what.
- Upstream 0.6.0 (plugins, themes, side conversations, chat format 2) is merged and shipped to `side-tutor` and to the server's branch (sync protocol 2): see `docs/upstream-0.6.0.md` for the owner's choices, what was added after the merge (the Tutor's morph, tablet touch rules, Chromium in the server image), and what is still open (plugin security, the fork's own coding questions plugin). Upstream's own workflows are deleted from the fork.
- Keep this file, `docs/side-tutor.md`, `docs/cloud-sync.md` and `docs/upstream-0.6.0.md` technical. The fork is public: no personal information.
