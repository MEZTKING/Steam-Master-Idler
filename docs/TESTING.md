# Testing with real Steam

`npm test` covers everything that can be checked without Steam (Steam is faked there). This list is
what only a real Steam account and the Steam app can show. Go through it once per release (or for
the parts a release changes), ideally as a **beta** first (Actions → Build → Run workflow → Publish a
release + Beta, with Settings → Updates → *Get beta versions* on).

If something fails: Settings → **Save debug report** (or the 🛠 Developer tab) and attach the file.

## Signing in and idling
- [ ] Sign in with the QR code, and with username + password + Steam Guard.
- [ ] Hours idler: start two games; the Steam status line says "In-game"; your friends list shows you playing.
- [ ] Card idler: **↻ Check drops** lists your games with drops left (if it says 0 badges while you have some, send the debug report: Steam may have changed the badges page).
- [ ] Idling through the Steam app (Windows): start idling, then launch another game in Steam; both run.
- [ ] Quit from the tray: you're no longer shown in-game.

## Screenshot uploader
- [ ] Take a screenshot (F12) in a game, close the game: it uploads within a minute, **Private**, and shows under Uploaded.
- [ ] While uploading, the **Uploading** tab shows the screenshot and its steps.
- [ ] **🔎 Find screenshots missing from Steam**: screenshots you uploaded in the Steam app count as uploaded; the rest are listed.
- [ ] A game Steam refuses (a demo or playtest) is listed as refused and not retried.

## Screenshot manager
- [ ] The gallery shows your screenshots with ☁ on the uploaded ones.
- [ ] Like a few, **Back up**: they appear in the backup folder, one folder per game.
- [ ] Move one to the trash and restore it; Steam's screenshot manager still shows it afterwards.
- [ ] **＋ Import images**: a PNG becomes a screenshot of the chosen game at the chosen size and uploads.
- [ ] **Remove from Steam** on an uploaded one: it's gone from your Steam screenshots page.

## Launch options
- [ ] Open a game: **Default** shows the launch options Steam has for it.
- [ ] Steam closed: pick another config; Steam's game Properties → Launch Options shows it.
- [ ] Steam running: **Restart Steam and apply now** closes Steam, applies, starts Steam again.
- [ ] Steam running: **When I close Steam**, then close Steam: applied.
- [ ] **▶ Play** starts the game with that config's options, without changing them.

## Other tools
- [ ] Achievement manager: load a game, unlock one, check your Steam profile; lock it again.
- [ ] Wishlist alerts: **Check now** lists your wishlist with prices in your currency.
- [ ] Sale event helper (during a Steam sale): **Run now** claims the daily sticker.
- [ ] Free game claimer: a free-to-play game's store link adds it to your library.
- [ ] Badges & boosters, Playtime reports, Library cleanup, Market value, Backups, Profile rotator: switch on and press their check/run buttons once.

## App
- [ ] Settings → Backup & sync: back up to your Google Drive / OneDrive folder; on another computer, restore it.
- [ ] Updates: an installed older version offers the new one; **Update** installs it and restarts (Windows installer, AppImage), keeping your settings.
- [ ] Coming from Steam Master Idler: after installing Kettle, your settings, sign-in and stats are still there.
- [ ] Android: sign in, idle, the notification shows; **Update** opens the APK download.
