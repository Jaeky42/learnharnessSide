# The fork's docs

This repository is a fork of amosblomqvist/learnharness, based on upstream **v0.7.0** (merged with `git merge`, first v0.6.0 and then v0.7.0 on top of it; the owner's choices at both merges are in `docs/fork/upstream.md`). The fork adds:

- the side tutor and the notes drawer;
- a separately installed Windows app that updates itself from this fork's releases;
- cloud sync between the desktop app and a self-hosted server, with several accounts on one server;
- phone and tablet layouts for the server's site, and its home-screen app;
- smaller additions to the lesson screen, the model lists and the agents.

Everything in `docs/fork/` is the fork's. Every other file under `docs/` is the upstream project's and is left as upstream wrote it, so that a later upstream release merges cleanly.

## The map: read this before you change that

| Before changing… | Read |
|---|---|
| anything: what shipped, on which branch, what the owner has confirmed, what is open | `status.md` |
| the release workflows, the Windows packaging, which branch gets a push, the order of updating the server and the PC | `releases.md` |
| the Tutor: its window, bubble, look, Dictate button, conversations, phone sheet | `side-tutor.md` |
| the notes drawer | `notes.md` |
| the lesson screen: a check that opens by scrolling, where a lesson rests when it opens, money and formulas, demos and the theme, the highlight toolbar on touch, dictation | `lesson.md` |
| sync: pairing, sessions and leases, seamless sessions, the graph log, settings, session folders, deleting a folder with its sessions, timing, the sync screens, Flashcards sync, the protocol number | `cloud-sync.md` |
| server mode: the login, model sign-ins, the Obsidian vault on the server, the image and hosting, accounts on one server, server updates | `server.md` |
| the phone layout, touch behaviour on a phone or a tablet (session folders included), the keyboard, the home-screen app, plugins on a phone | `phone-and-tablet.md` |
| the model lists (Fable, GPT-6.2) or the research agent | `models-and-agents.md` |
| plugins: the Drawing Pad, the core plugins, plugin security | `plugins.md` |
| a file that upstream also has, or anything at the next upstream release | `upstream.md` (the 0.6.0 and 0.7.0 decisions, and the list of the fork's edits to upstream files) |
| anything for speed on long sessions | `performance.md` |

Those files are loaded into every Claude Code session through `CLAUDE.md`. These are not, and are read when the work needs them:

| File | Holds |
|---|---|
| `development.md` | development notes and recipes: commands, Node versions, known test failures, running server mode, two copies for a sync run, browser runs at phone size, the stand-ins for Obsidian and for the accounts stack |
| `history/<topic>.md` | for each topic file: how it got built (rounds, attempts, reverts) and the records of what was run and measured; also text about screens that no longer exist, each marked with what retired it |
| `history/ship-log.md` | each round's ship record, as written at the time: branch, commits, release, way back, what the owner said |
| `plans/` | the approved plans (`multi-account-plan.md`, `multi-account-build.md`, `phone-plugins-plan.md`) and two drafts that are not approved (`own-coding-plugin-plan.md`, with its spike in `spikes/`; `voice-session-plan.md`, a spoken lesson as its own kind of session, with the owner's eight decisions) |
| `review-policy.md` | the operator reference for the review policy in `CLAUDE.md` |

## How each topic file is laid out

Each `##` section is one subject. Inside it, in this order:

1. how it works now;
2. `### The owner's decisions and approved words`: change one only with the owner's approval;
3. `### Rulings, limits and open items`: what was decided while building and is waiting for the owner's review, known limits, what only the owner's devices or the real server can show, what is open;
4. `### Code and tests`.

## Where new text goes

- A change in how something works: the topic file, in the section for that subject. Correct the sentence that is no longer true; don't add a "since then" note beside it.
- A decision of the owner's, or approved wording: the same section's decisions block, in the owner's words. A decision that replaces an earlier one: note it at the earlier one, and move retired on-screen words to the history file.
- What was run, measured or reviewed, and how a round went: `history/<topic>.md`.
- A ship: one entry in `history/ship-log.md` (branch, commits, release, way back, the owner's word), and one row in `status.md`.
- A recipe or a development note: `development.md`.
- Keep everything technical. The fork is public: no personal information.

## How the owner works

- **Per AGENTS.md:**
  - Investigate first, then ask design questions **one per AskUserQuestion call**.
  - Get the phase plan approved, then build.
  - Never guess a design or wording decision.
- **The owner prefers visuals.** Use diagrams and mockups in questions, and phone-friendly step-by-step guides as Artifact pages for anything done on the server. Each command is tagged with where it runs, and the guide has fill-in boxes for values like the domain.
- **The owner is new to servers.** The PC is Windows (PowerShell, not Command Prompt). Spell out every command and what success looks like. Never ask the owner to paste secrets, setup codes or sign-in codes into chat.
- **Each phase ends with:**
  - tests and `npm test` / typecheck / lint;
  - a real browser check (Playwright) in server mode;
  - a commit and push to the branch;
  - a "what to try on your server" list.
- The guide's server commands must each start with `cd ~/learnharnessSide/deploy &&`: `docker compose` only works from that folder (the owner hit this).
