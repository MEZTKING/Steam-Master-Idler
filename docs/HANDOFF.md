# Kettle: handoff notes

Everything needed to pick up work on Kettle in a new session or on another account. Last
updated after the **v1.12.0** release (2026-11-19).

## Where things are
- **Repository:** https://github.com/MEZTKING/Steam-Master-Idler. The repo name is unchanged; the
  app has been called **Kettle** since v1.11.0.
- **Default branch:** `main`. Every change so far went through a PR and was merged with rebase.
  - PR #1 to #8 cover v1.7.0 to v1.12.0.
  - The last work branch was `claude/practical-ptolemy-8pvlm5`. It has the same tree as `main`.
- **Latest release:** v1.12.0, https://github.com/MEZTKING/Steam-Master-Idler/releases/tag/v1.12.0
  - Windows: Setup .exe and Portable .exe
  - macOS: dmg for x64 and arm64
  - Linux: AppImage and .deb
  - Android: APKs for arm64-v8a, armeabi-v7a, x86_64 and universal
- **A new account needs access to the repo:** add it as a collaborator on GitHub (Settings →
  Collaborators), or fork the repo. For a Claude cloud session, the Claude GitHub app must be
  installed on the repo and the account must be connected to GitHub.

## Rules the owner set (follow these)
1. **Every change is committed and pushed, and the docs are updated with it.** That means the README
   and the files in `docs/`. Nothing is left only on a local disk.
2. **No Claude or AI attribution anywhere.**
   - No `Co-Authored-By` lines and no session links in commits.
   - No "Generated with" footers on PRs or comments.
   - The history was rewritten once to remove these. Don't add them back.
3. **Commit author:** `Lelouch <rakib1rana@gmail.com>`. Set it with:
   `git config user.name "Lelouch"` and `git config user.email "rakib1rana@gmail.com"`
4. When the owner says "merge it and release":
   1. Bump the version in `package.json`.
   2. Merge the PR into `main`.
   3. Run the release (see "Releasing" below).
5. The owner writes short messages and wants the work done, not a list of options.

## What the app is
An Electron desktop app, also available for Android, plus a CLI.
- **Core:** a Steam hours/card idler that runs over a direct Steam connection (`steam-user`).
- **Optional "tools":** each one can be switched on or off. An enabled tool gets its own tab in the
  top menu. Disabled tools are never loaded, which keeps resource use low.

| Tool id | What it does |
|---|---|
| screenshots | Auto-uploads screenshots to Steam Cloud as Private after the game closes. Game by game, oldest first. Checks Steam Cloud before sending. "Find missing" finds older screenshots that never uploaded. Upload queue view. |
| gallery | Screenshot manager: like/dislike, backups, trash, remove from Steam. Import with resize to Steam's limits. |
| launch | Several launch-option configs per game plus a Default. Writes `localconfig.vdf` while Steam is closed: right away, by restarting Steam, or once you close Steam yourself. |
| achievements | Achievement manager (SAM-like): read the schema, then unlock or lock achievements. |
| wishlist | Sale alerts, price targets, free-game alerts, "could be delisted soon". |
| sale | Sale event helper: discovery queue, sale stickers. |
| freegames | Free game claimer. |
| badges | Card farming extras: badge info, booster packs. |
| playtime | Weekly playtime reports. |
| cleanup | Library cleanup: refund candidates, orphan DLC. |
| market | Inventory value, read-only. |
| backups | Backups. |
| profile | Profile showcase rotator. |

App-wide features:
- In-app updater from GitHub Releases, with a beta channel.
- Developer mode with a debug log and "Save debug report".
- Settings backup and sync to a Google Drive, OneDrive, Dropbox or iCloud folder. The Steam password
  and sign-in token are never included.
- First-run welcome screen.

## Code map
- `src/main.js`: Electron shell.
  - Tray, window, installing updates.
  - On first start, moves data from the old "Steam Master Idler" folder to the "Kettle" folder.
- `src/server.js`: local HTTP server and Steam connection. Provides config, routes and the tools.
  - Tool routes: `GET|POST /api/tools/<id>/<action>`.
- `public/index.html`: the whole UI, as a single page with no framework.
- `src/tools/index.js`: the tool registry (defaults, desktopOnly, lazy `load`).
  - Each tool lives in `src/tools/<id>/index.js` and exports `create(ctx)`.
  - `create` returns `{ snapshot, routes, on: { loggedOn, stop } }`.
- `src/lib/`:
  - `steam-cm.js`: raw Steam CM calls.
    - `callService` for unified methods, which checks the eresult in the header.
    - `sendMsg` for classic messages, which ignores the header eresult: it decodes as 2 (Fail) even
      when the call worked.
  - `steam-local.js`: Steam folder, running app, close and start Steam.
  - `vdf.js`, `vdf-edit.js`: VDF reader, and a position-preserving VDF editor.
  - `binkv.js`: binary KV, for the achievement schema.
  - `store.js`, `web.js`: store items, and Steam web requests with cookies.
  - `cards.js`: the card idler's badge-page parsing.
  - `updater.js`, `settings-sync.js`, `debuglog.js`.
- `src/mobile.js`, `android/`: the Android build (Node runtime in a WebView). `src/cli.js`: the CLI.
- `tests/`: 44 node:test tests with a fake Steam. Run them with `npm test` (about 5 s).
- `docs/TESTING.md`: checklist for testing with a real Steam account.
- `scripts/make-icons.js`: `npm run icons` renders every icon from `assets/src/icon.svg`.

### Steam details that took effort to get right
- **Screenshot upload sequence:**
  1. `Cloud.ClientBeginFileUpload#1` with appid 760
  2. HTTP PUT of the blocks
  3. `Cloud.ClientCommitFileUpload#1`
  4. `ClientUCMAddScreenshot` with permissions 2 (Private)
- **Upload results:**
  - DuplicateRequest (29) means the screenshot is already there; count it as done.
  - AccessDenied (15) means the game isn't owned. Mark the app as denied and stop sending its
    screenshots.
- **Steam Cloud listing:** `Cloud.EnumerateUserFiles#1`. Matching files are skipped by SHA-1.
- **Upload order:** game by game, games ordered by their oldest screenshot; inside a game, oldest
  to newest. The time comes from the file name (`YYYYMMDDHHMMSS_N.jpg`), not the file date.
- **Launch options** are stored at
  `userdata/<acct>/config/localconfig.vdf → UserLocalConfigStore/Software/Valve/Steam/apps/<appid>/LaunchOptions`.
  Steam rewrites this file when it closes, so only write it while Steam is closed. A backup of the
  file is kept first.

## Build, CI and releasing
- Workflow: `.github/workflows/build.yml`.
  - The `test` job runs first.
  - Then `build` runs on Windows, macOS and Linux, alongside `android`.
  - The `release` job runs last.
- **Releasing:**
  1. Bump `version` in `package.json` and merge to `main`.
  2. Go to Actions → Build → Run workflow on `main`.
  3. Tick "Publish a release" (add "Beta" for a pre-release).
  4. The workflow creates the tag `v<version>` and the release with all files. It refuses to run if
     that release already exists.
  - Pushing a `v*` tag also releases.
- The macOS job sometimes waits a long time for a runner, or gets cancelled with no runner. If that
  happens, re-run it.
- **Android signing:**
  - The project's own key is `android/release.keystore`. Its default passwords are in
    `android/app/build.gradle`.
  - The CI env vars `ANDROID_KEYSTORE*` override it.
  - Keep the same key, or existing installs can't update.
- **App ids:** the internal ids `com.meztking.steammasteridler` (desktop and Android package) are
  unchanged on purpose, so updates install over old versions. Don't rename them.
- Toolchain: Node 20 in CI, Electron 33, steam-user 5.3.

## Open items
1. **Card idler shows 0 badges** for the owner's account. Steam's badges page markup probably
   changed.
   - Since v1.9.0, `src/lib/cards.js` records the page shape (`pageShape`) in the debug log when a
     large page gives 0 rows.
   - Waiting for a debug report from v1.12.0: Developer mode → Save debug report, taken after
     "Check drops".
   - With that report, fix the parser and add a test.
2. **Needs the owner:** code signing (Windows and macOS), and store listings (winget, Flathub,
   F-Droid).
3. **Deferred cleanup:** split `public/index.html` (about 3,100 lines) and `src/server.js` (about
   1,400 lines) into smaller files.
4. The owner has confirmed the screenshot uploader works in real use (78+ uploaded). Other tools
   were only tested with the fake Steam. See `docs/TESTING.md`.

## Starting a new session
1. Clone the repository: `git clone https://github.com/MEZTKING/Steam-Master-Idler`
2. Install and test: `npm ci`, then `npm test`
3. Run the app: `npm start` for Electron, or `npm run web` for the browser UI.
4. Read this file, `README.md` and `docs/TESTING.md`.
5. Set the git author (see the rules above). Work on a branch, then open a PR to `main`.
