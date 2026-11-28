# Releases: the Windows app, the branches and the update order

## The separate Windows app

- `electron-builder.side-tutor.yml` extends `electron-builder.yml` with:
  - its own appId (`com.learnharness.SideTutor`), productName and executable (`LearnHarnessSideTutor.exe`);
  - its own **package name**, `learnharness-side-tutor`.
- **Why the package name matters:** a one-click per-user NSIS install names its folder after package.json `name`, not productName (app-builder-lib `getWindowsInstallationDirName`). With the upstream name, the side tutor overwrote the official app in `%LOCALAPPDATA%\Programs\learnharness`, and either uninstaller deleted both. It now installs to `%LOCALAPPDATA%\Programs\learnharness-side-tutor`. Pinned by `tests/side-tutor-install.test.ts` and a CI check.
- It shares the official app's data folder (`%APPDATA%\LearnHarness`) on purpose, because `electron/main.cjs` pins `app.setName("LearnHarness")`. Because of that, the two apps can't run at the same time (shared single-instance lock).
- NSIS never deletes app data on uninstall.
- The installer is unsigned (SmartScreen: More info → Run anyway).

## Auto-updates and the release workflow

- The update feed is this fork's GitHub Releases (`publish` in the side config: provider github, owner Jaeky42, repo learnharnessSide, releaseType release).
- `publish` **must stay a single object**. The `extends` merge concatenates arrays (builder-util-runtime `deepAssign`), so a list would keep the official feed first.
- `.github/workflows/side-tutor-windows.yml` runs on every push to `side-tutor`, in this order:
  1. Stamps version `<major>.<minor>.<run number>` into the runner's package.json (never committed). electron-builder 26 has no `--em` flag. Since the 0.7.0 merge `package.json` says 0.7.0, so releases read 0.7.<run number> (they were 0.6.<run number>; the update check takes 0.7.x as newer).
  2. Runs the side-tutor, notes and cloud sync tests on Windows, builds, and smoke-tests the server and the packaged app.
  3. Checks that the packaged `app-update.yml` points at this fork and that the package name and version are right.
  4. Only then publishes a GitHub Release (`gh release create`, with the installer, blockmap and latest.yml).
- Pushes that only change `CLAUDE.md` or `docs/**` don't run the workflow.
- **A dry run:** started by hand (`workflow_dispatch`) on any branch, the workflow does everything except the last step. It tests, builds and attaches the installer to the run, and publishes no release. Used to check the cloud sync branch on Windows before its merge.
- `LH_BUILD_VERSION` / `LH_BUILD_HOMEPAGE` (next.config.ts) make Settings show the stamped version and link release notes to this fork.
- **Startup announcements are off** (owner's decision at the 0.7.0 merge; "The owner's decisions at the 0.7.0 merge" in `docs/fork/upstream.md`). Upstream's packaged desktop app asks `https://learnharness.ai/startup-messages.json` at every launch and shows the newest message once (`electron/startup-messages.cjs`). Those messages are written for the official app; Side Tutor updates itself from this fork's releases. Chosen over keeping the feed and over a feed of the fork's own.
  - **What was done:** in `electron/main.cjs` (`FORK (startup announcements off)`) the main process never starts the feed, so no request is made and no dismissal file is written. Upstream's `startup-messages.cjs`, the two IPC handlers (`lh:startup-message:take` and `:dismiss`, which now answer "no message"), `electron/preload.cjs` and the renderer's box (`components/startup-message.tsx`) stay in place, unused, so later upstream releases merge cleanly. Browser and server mode never had the feed.
  - **Pinned by** `tests/startup-messages-off.test.ts` (it reads the main process's source and fails if it can start the feed). Upstream's own `tests/startup-messages.test.ts` still runs, with its notifier-workflow case skipped while upstream's two notify workflows are absent.
  - **Not checked:** the packaged Windows app itself (that no request is made and the box never shows).
- To pick up upstream: merge the new upstream release into the fork's history (as `git merge v0.6.0` and then `git merge v0.7.0` were, on `claude/upstream-0.6.0`), then fast-forward both release branches to that commit, with the owner's approval. So far both release branches have only ever moved by fast-forward.

## Which branch feeds what

- **Which branch changes what, from now on:**
  - a push to `side-tutor` publishes a desktop release (and builds the server image `:latest`). It still needs the owner's approval every time;
  - the owner's server follows `LH_CHANNEL=dev`, which is built from `claude/pensive-goldberg-7dty2m`. A change the server should get must be pushed there; a change both should get goes to both branches, kept at the same commit.
  - Moving the server to `latest`, so one branch feeds both, is the owner's call and hasn't been asked.
  - **Once the owner has set up the deploy key, a push to `claude/pensive-goldberg-7dty2m` updates the owner's server by itself** a few minutes after its image is published ("Updating from GitHub after a push" in `docs/fork/server.md`). Until then the server takes the image at 4 am or when the owner starts the update.
- **The two sides must speak the same sync protocol version** (1 in release 0.5.6; **2 from the upstream 0.6.0 merge on**, see `docs/fork/upstream.md`; **3 with Flashcards sync**, see "Flashcards sync" in `docs/fork/cloud-sync.md`; **still 3 at the upstream 0.7.0 merge**, which changes no wire format, chat format or Flashcards file, so the server and a PC can be updated in either order). A change that raises it has to reach the server and the desktop together, or sync pauses until both are updated.

## Updating the server and the PC together

- **Version rule:**
  - The desktop and server exchange a sync protocol version on every sync.
  - If they don't match, sync **pauses**: the desktop keeps working locally and shows "Update the server to continue syncing" (or "Update LearnHarness to continue syncing" when the app is the older side).
  - Releases that change a data format are marked, so they're never applied to only one side.

A release that raises the sync protocol means both sides must be updated, or sync pauses (nothing is discarded while it is paused). The same commit goes to both branches, the server's first. The steps, as written for protocol 2 (the upstream 0.6.0 merge):

1. The official LearnHarness app stays closed until the end: it shares the data folder, and once updated it writes format 2 without knowing about sync or held sessions.
2. In Side Tutor: Settings → Cloud → Sync now, until "Up to date". No reply or helper left running.
3. A copy of the PC's data folder and of the server's data, by hand. Format 2 is one-way, and the automatic backup was made only once, at the first sync.
4. Push to the server's branch (owner's approval). The image builds; the owner updates the server and checks the site from the phone. Meanwhile the PC shows SYNC PAUSED and "Update LearnHarness to continue syncing". Don't continue a session the PC holds on another device during this gap (since seamless sessions there is no Take over: typing there moves the session).
5. Push the same commit to `side-tutor` (owner's approval). The release builds; the app installs it at its next start. Settings → Cloud reads "Up to date" again.
6. Plugins are off by default and per device: switch the same ones on in both places, from a computer.

**Protocol 3 (Flashcards sync)** means the same: both sides must be updated, the server first, or all sync pauses, with nothing discarded. The steps above apply again as they stand. The round changes no file format (the chat record stays at 2, Flashcards' file at 1); only the protocol rises. Step 3's copy by hand covers Flashcards too; its own automatic backup is made once, right before each side's first Flashcards exchange. Steps 4 and 5 were done (both were fast-forwards), and the server has been updated since (the switch-over to several accounts: "everything works great"; `docs/fork/history/ship-log.md`). The PC updates itself at its next start; the docs record no word from the owner on that update by itself.
