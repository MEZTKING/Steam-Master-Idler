'use strict';

// Tool: Backups.
// Daily or weekly, into a folder you choose (default: "backups" in the app's data folder):
//   <folder>/<date>/playtime.json + playtime.csv     your library with playtime and last played
//   <folder>/<date>/achievements.json                achievements of games you played recently
//                                                     (or of every played game with "all games")
//   <folder>/screenshots/<game>/<file>.jpg           new screenshots, copied once (desktop only)
// Keeps the newest N dated backups and removes older ones. Nothing is uploaded anywhere.

const fs = require('fs');
const path = require('path');
const { loadAchievements } = require('../achievements');
const { findSteamDir, screenshotsRoot } = require('../../lib/steam-local');

const CHECK_MS = 3_600_000;
const EVERY = { daily: 86_400_000, weekly: 7 * 86_400_000 };
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+$/, '').slice(0, 80) || 'Unknown';
const stamp = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}_${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`;
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.history ??= [];
	let timer = null;
	let overdue = null;
	let busy = null;   // { step, done, total }

	const folder = () => cfg.folder || path.join(ctx.dataDir, 'backups');

	async function run(manual = false) {
		if (busy) throw new Error('A backup is already running.');
		if (!ctx.isLoggedIn()) throw new Error('Log in first');
		busy = { step: 'Starting', done: 0, total: 0 };
		const started = Date.now();
		const dir = path.join(folder(), stamp());
		const summary = [];
		try {
			fs.mkdirSync(dir, { recursive: true });
			// playtime
			busy.step = 'Playtime';
			const lib = ctx.library();
			const rows = lib.map((g) => ({ appid: g.appid, name: g.name, minutes: g.minutes, hours: +(g.minutes / 60).toFixed(2), lastPlayed: g.lastPlayed ? new Date(g.lastPlayed).toISOString() : null }));
			fs.writeFileSync(path.join(dir, 'playtime.json'), JSON.stringify({ steamID: ctx.steamID64(), at: new Date().toISOString(), games: rows }, null, 2));
			fs.writeFileSync(path.join(dir, 'playtime.csv'), ['appid,name,minutes,hours,last_played', ...rows.map((r) => [r.appid, r.name, r.minutes, r.hours, r.lastPlayed || ''].map(csvCell).join(','))].join('\n'));
			summary.push(`${rows.length} games' playtime`);

			// achievements
			if (cfg.achievements) {
				const twoWeeks = Date.now() - 14 * 86_400_000;
				const games = lib.filter((g) => g.minutes > 0 && (cfg.allAchievements || g.recent > 0 || (g.lastPlayed && g.lastPlayed > twoWeeks)));
				busy = { step: 'Achievements', done: 0, total: games.length };
				const out = [];
				for (const g of games) {
					if (!ctx.isLoggedIn()) break;
					try {
						const a = await loadAchievements(ctx.client, ctx.steamID64(), g.appid, g.name);
						if (a.achievements.length) {
							out.push({ appid: g.appid, name: a.name, unlocked: a.achievements.filter((x) => x.unlocked).length, total: a.achievements.length,
								achievements: a.achievements.map((x) => ({ api: x.apiName, name: x.name, unlocked: x.unlocked, at: x.unlockedAt ? new Date(x.unlockedAt).toISOString() : null })) });
						}
					} catch { /* no achievements */ }
					busy.done++;
					await new Promise((r) => setTimeout(r, 1200));   // gentle on Steam
				}
				fs.writeFileSync(path.join(dir, 'achievements.json'), JSON.stringify({ at: new Date().toISOString(), games: out }, null, 2));
				summary.push(`achievements of ${out.length} games`);
			}

			// screenshots (copied once into one shared folder, so nothing is duplicated)
			if (cfg.screenshots && !ctx.mobile) {
				busy = { step: 'Screenshots', done: 0, total: 0 };
				const steamDir = await findSteamDir(null, ctx.accountId());
				const remote = steamDir && path.join(screenshotsRoot(steamDir, ctx.accountId()), 'remote');
				let copied = 0;
				if (remote && fs.existsSync(remote)) {
					for (const d of fs.readdirSync(remote).filter((x) => /^\d+$/.test(x))) {
						const src = path.join(remote, d, 'screenshots');
						let files = [];
						try { files = fs.readdirSync(src).filter((f) => /\.jpe?g$/i.test(f)); } catch { continue; }
						const dest = path.join(folder(), 'screenshots', safeName(Number(d) < 0x80000000 ? ctx.gameName(+d) : `Non-Steam ${d}`));
						for (const f of files) {
							const to = path.join(dest, f);
							const size = fs.statSync(path.join(src, f)).size;
							if (fs.existsSync(to) && fs.statSync(to).size === size) continue;
							fs.mkdirSync(dest, { recursive: true });
							fs.copyFileSync(path.join(src, f), to);
							copied++;
						}
					}
				}
				summary.push(`${copied} new screenshot${copied === 1 ? '' : 's'}`);
			}

			// keep the newest N dated backups
			const dated = fs.readdirSync(folder()).filter((x) => /^\d{4}-\d{2}-\d{2}_\d{4}$/.test(x)).sort();
			for (const old of dated.slice(0, Math.max(0, dated.length - cfg.keep))) fs.rmSync(path.join(folder(), old), { recursive: true, force: true });

			st.lastRunAt = Date.now();
			const text = `Saved ${summary.join(', ')}.`;
			st.history.unshift({ at: Date.now(), ok: true, text, dir, seconds: Math.round((Date.now() - started) / 1000) });
			if (manual || cfg.notify) ctx.log(`💾 Backup done: ${summary.join(', ')}.`, cfg.notify);
		} catch (err) {
			st.history.unshift({ at: Date.now(), ok: false, text: err.message, dir });
			ctx.log(`💾 Backup failed: ${err.message}`, true);
			ctx.debug(err.stack || err.message);
		} finally {
			st.history.length = Math.min(st.history.length, 10);
			ctx.saveState();
			busy = null;
		}
	}

	function schedule() {
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (ctx.isLoggedIn() && Date.now() - (st.lastRunAt || 0) >= EVERY[cfg.every]) run().catch(() => {});
			schedule();
		}, CHECK_MS);
	}

	return {
		snapshot: () => ({
			busy, folder: folder(), lastRunAt: st.lastRunAt || null,
			nextAt: st.lastRunAt ? st.lastRunAt + EVERY[cfg.every] : null,
			history: st.history.slice(0, 5),
		}),
		routes: {
			'POST settings'(body) {
				for (const k of ['achievements', 'allAchievements', 'screenshots', 'notify']) if (k in body) cfg[k] = !!body[k];
				if (body.every in EVERY) cfg.every = body.every;
				if ('keep' in body) cfg.keep = Math.max(1, Math.min(100, parseInt(body.keep, 10) || 10));
				if (typeof body.folder === 'string') {
					const f = body.folder.trim();
					if (f && !path.isAbsolute(f)) throw new Error('Use a full folder path, like C:\\Backups\\Steam or /home/me/steam-backups');
					cfg.folder = f;
				}
				ctx.saveConfig();
			},
			'POST run'() { run(true).catch(() => {}); },
			'POST open-folder'() { fs.mkdirSync(folder(), { recursive: true }); ctx.openPath(folder()); },
		},
		on: {
			loggedOn() {
				schedule();
				// overdue (e.g. the PC was off): run a few minutes after signing in
				clearTimeout(overdue);
				if (Date.now() - (st.lastRunAt || 0) >= EVERY[cfg.every]) overdue = setTimeout(() => { if (!busy) run().catch(() => {}); }, 5 * 60_000);
			},
			stop() { clearTimeout(timer); clearTimeout(overdue); timer = overdue = null; },
		},
	};
}

module.exports = { create };
