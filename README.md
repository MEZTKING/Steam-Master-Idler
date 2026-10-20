<p align="center"><img src="assets/icon.png" width="120" alt=""></p>

<h1 align="center">Steam Master Idler</h1>

<p align="center">Idle your Steam games until they hit the hours you want, and farm trading-card drops,<br>without running the games or even the Steam client.</p>

---

## Features

- **Per-game targets:** idle a game **forever**, **until its total reaches X hours**, **for another X hours**, or **until its card drops run out**.
- **Card-drop farming:** see which games still have trading cards to drop and queue them all with one click. Each game stops when its drops are gone.
- **QR-code login:** scan with the Steam mobile app; no password typed. Username, password and Steam Guard also work. You only log in once.
- **Up to 32 games at once.** Extra games wait in a queue and start as others finish.
- **Session limit:** stop everything after X hours.
- **Runs in the tray:** closing the window keeps it idling. Desktop notifications tell you when targets are reached.
- **Pauses automatically** if you start playing on another device, and resumes when you stop.
- Optional "start when I log in", custom status text and online/invisible status.

No game is actually launched, so there is no VAC risk.

## Download

Grab the installer for your system from the [Releases](https://github.com/MEZTKING/Steam-Master-Idler/releases) page:

| System | File |
|---|---|
| Windows | `Steam-Master-Idler-Setup-x.y.z.exe` (installer) or `…-Portable-x.y.z.exe` (no install) |
| macOS | `Steam-Master-Idler-x.y.z-arm64.dmg` (Apple Silicon) or `…-x64.dmg` (Intel) |
| Linux | `.AppImage` or `.deb` |

The builds aren't code-signed, so the first launch shows a warning:
- **Windows:** "Windows protected your PC" → *More info* → *Run anyway*.
- **macOS:** right-click the app → *Open* → *Open*. Or run `xattr -cr "/Applications/Steam Master Idler.app"`.

## Using it

1. Open the app and scan the QR code with the Steam mobile app (Steam Guard → scan QR), then tap Approve.
2. Click **+ Add** on games in your library, or **🃏 Add card games**.
3. Pick a mode and hours for each game, then click **▶ Start idling**.

Close the window and it keeps going in the tray. Choose **Quit** from the tray menu to stop. Quitting always takes you out of "in-game" status.

Your settings and login token are stored in your user data folder (tray → *Open data folder*). Delete `.session` there, or click **Log out**, to forget the login.

## Run from source

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start              # desktop app
npm run web            # same UI in your browser at http://127.0.0.1:3000
npm run cli -- --help  # command-line version
npm run dist           # build an installer for your OS into dist/
```

From source, `config.json`, `.session` and `state.json` live in the project folder.

### Command line

```bash
npm run cli -- --qr                    # log in with a QR code in the terminal
npm run cli -- --list                  # your games and hours
npm run cli -- -g 730:100 -g 440:+5    # CS2 until 100h total, TF2 for 5 more hours
npm run cli -- -g 570                  # idle forever
npm run cli -- --cards                 # farm every game with card drops left
npm run cli -- --stop-after 8          # stop after 8 hours
```

## Releasing

Push a version tag and GitHub Actions builds every installer and publishes a release:

```bash
npm version 1.0.1      # bumps package.json and creates the tag
git push --follow-tags
```

Every push to `main` also builds the installers; download them from the run's **Artifacts** on the Actions tab.

## How it works

The app logs in to Steam's client network with [steam-user](https://github.com/DoctorMcKay/node-steam-user), the same way a Steam client does, and reports the chosen games as being played. Steam then counts the playtime. Card drops are read from your badges page using the web session Steam issues at login.

---

Not affiliated with Valve or Steam. Idling is a grey area under Steam's terms of service; use it at your own risk.
