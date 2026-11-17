'use strict';

// Tool: Screenshot uploader.
// Watches the folder the Steam app saves your screenshots in (F12) and, once you close the game,
// uploads the new ones to your Steam screenshot library (Steam Cloud), Private by default, so you
// don't have to press Upload in Steam's screenshot manager.
//
// Screenshots taken before the tool was switched on are left alone; "Upload older screenshots"
// uploads those too (skipping any that Steam's own screenshots.vdf already lists as uploaded).

const fs = require('fs');
const path = require('path');
const { findSteamDir, screenshotsRoot, runningAppId } = require('../../lib/steam-local');
const { parseVdf } = require('../../lib/vdf');
const { uploadScreenshot, jpegSize, PRIVACY } = require('./uploader');

const TICK_MS = 20_000;
const SETTLE_MS = 15_000;            // a new file must be this old (Steam is done writing it + its thumbnail)
const QUIET_MS = 10 * 60_000;        // when we can't tell which game is running: no new screenshots for this long
const MAX_TRIES = 3;
const NON_STEAM = 0x80000000;        // shortcut (non-Steam game) app ids have the high bit set
const RECENT_MAX = 30;
const isJpeg = (f) => /\.jpe?g$/i.test(f);
const UNSET = new Set(['', '0', '18446744073709551615']);

// 20240131235959_1.jpg -> unix seconds (local time), else null
function timeFromName(name) {
	const m = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
	if (!m) return null;
	const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
	return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Electron can shrink images; plain Node (npm run web) can't, then the full image doubles as thumbnail
function makeThumb(file) {
	try {
		const { nativeImage } = require('electron');
		const img = nativeImage.createFromPath(file);
		if (img.isEmpty()) return null;
		const { width, height } = img.getSize();
		const r = 200 / Math.max(width, height);
		return img.resize({ width: Math.max(1, Math.round(width * r)), height: Math.max(1, Math.round(height * r)), quality: 'good' }).toJPEG(90);
	} catch {
		return null;
	}
}

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.uploaded ??= {};     // "<appid>/<file>" -> { at, id }
	st.failed ??= {};       // "<appid>/<file>" -> { tries, at, error }
	st.queued ??= {};       // older screenshots the user asked to upload: key -> true
	st.recent ??= [];
	st.count ??= 0;
	// only screenshots taken after switching it on; older ones need "Upload older screenshots"
	if (ctx.justEnabled || !st.baselineAt) { st.baselineAt = Date.now(); ctx.saveState(); }

	let steamDir = null;
	let root = null;
	let lookedUpAt = 0;
	let timer = null;
	let busy = false;
	let lastRunning = new Set();
	let detectable = true;    // can we see which game the Steam app runs?
	const dirCache = new Map();   // dir -> { mtimeMs, files: [{ name, mtimeMs, size }] }
	let vdfCache = { mtimeMs: 0, done: new Set() };
	const view = { pending: [], waiting: [], backlog: 0, steamUploaded: 0, running: [], current: null, lastScanAt: null, error: null };

	const gameName = (appid) => ctx.gameName(appid);

	async function locate(force = false) {
		if (!force && root && Date.now() - lookedUpAt < 5 * 60_000) return root;
		lookedUpAt = Date.now();
		const accountId = ctx.accountId();
		if (accountId == null) return null;
		steamDir = await findSteamDir(cfg.steamDir || null, accountId);
		const r = steamDir && screenshotsRoot(steamDir, accountId);
		root = r && fs.existsSync(r) ? r : null;
		if (!root) dirCache.clear();
		return root;
	}

	function listDir(dir) {
		let stat;
		try { stat = fs.statSync(dir); } catch { dirCache.delete(dir); return []; }
		const hit = dirCache.get(dir);
		if (hit && hit.mtimeMs === stat.mtimeMs) return hit.files;
		const files = [];
		for (const name of fs.readdirSync(dir)) {
			if (!isJpeg(name)) continue;
			try {
				const s = fs.statSync(path.join(dir, name));
				if (s.isFile()) files.push({ name, mtimeMs: s.mtimeMs, size: s.size });
			} catch { /* removed meanwhile */ }
		}
		dirCache.set(dir, { mtimeMs: stat.mtimeMs, files });
		return files;
	}

	// screenshots Steam itself already uploaded (screenshots.vdf has a published file id / UGC handle for them)
	function steamUploadedSet() {
		const file = path.join(root, 'screenshots.vdf');
		let s;
		try { s = fs.statSync(file); } catch { return vdfCache.done; }
		if (s.mtimeMs === vdfCache.mtimeMs) return vdfCache.done;
		const done = new Set();
		try {
			const vdf = parseVdf(fs.readFileSync(file, 'utf8'));
			const shots = Object.entries(vdf).find(([k]) => k.toLowerCase() === 'screenshots')?.[1] || {};
			for (const [appid, entries] of Object.entries(shots)) {
				if (!/^\d+$/.test(appid) || typeof entries !== 'object') continue;
				for (const e of Object.values(entries)) {
					if (typeof e !== 'object' || !e.filename) continue;
					const id = e.publishedfileid ?? e.PublishedFileId ?? '';
					const ugc = e.ugchandle ?? e.UGCHandle ?? '';
					if (!UNSET.has(String(id)) || !UNSET.has(String(ugc))) done.add(`${appid}/${path.basename(e.filename)}`);
				}
			}
		} catch (err) {
			ctx.debug(`screenshots.vdf unreadable: ${err.message}`);
		}
		vdfCache = { mtimeMs: s.mtimeMs, done };
		return done;
	}

	// every screenshot on disk, sorted into: to upload now/soon, older ones, already done
	function scan() {
		const remote = path.join(root, 'remote');
		const steamDone = steamUploadedSet();
		const pending = [];
		let backlog = 0;
		let steamUploaded = 0;
		let appDirs = [];
		try { appDirs = fs.readdirSync(remote).filter((d) => /^\d+$/.test(d)); } catch { /* no screenshots yet */ }
		for (const d of appDirs) {
			const appid = Number(d);
			if (appid >= NON_STEAM) continue;   // non-Steam games: not supported
			const dir = path.join(remote, d, 'screenshots');
			for (const f of listDir(dir)) {
				const key = `${appid}/${f.name}`;
				if (st.uploaded[key]) continue;
				if (steamDone.has(key)) { steamUploaded++; continue; }
				const isNew = f.mtimeMs >= (st.baselineAt || Infinity);
				if (!isNew && !st.queued[key]) { backlog++; continue; }
				pending.push({ key, appid, dir, ...f });
			}
		}
		pending.sort((a, b) => a.mtimeMs - b.mtimeMs);
		return { pending, backlog, steamUploaded };
	}

	async function runningApps() {
		const set = new Set();
		const local = await runningAppId(steamDir);
		detectable = local != null || ctx.canSeePlaying();
		if (local) set.add(local);
		const elsewhere = ctx.playingElsewhere();
		if (elsewhere) set.add(elsewhere);
		return set;
	}

	function olderList() {
		const steamDone = steamUploadedSet();
		const games = [];
		let dirs = [];
		try { dirs = fs.readdirSync(path.join(root, 'remote')).filter((x) => /^\d+$/.test(x) && Number(x) < NON_STEAM); } catch { /* none */ }
		for (const d of dirs) {
			const shots = listDir(path.join(root, 'remote', d, 'screenshots'))
				.filter((f) => { const key = `${d}/${f.name}`; return !st.uploaded[key] && !st.queued[key] && !steamDone.has(key) && f.mtimeMs < (st.baselineAt || Infinity); })
				.map((f) => ({ key: `${d}/${f.name}`, name: f.name, takenAt: (timeFromName(f.name) || f.mtimeMs / 1000) * 1000, size: f.size }))
				.sort((a, b) => b.takenAt - a.takenAt);
			if (shots.length) games.push({ appid: +d, game: gameName(+d), icon: ctx.gameIcon ? ctx.gameIcon(+d) : null, shots });
		}
		return games.sort((a, b) => b.shots[0].takenAt - a.shots[0].takenAt);
	}

	function canRetry(key) {
		const f = st.failed[key];
		if (!f) return true;
		if (f.tries >= MAX_TRIES) return false;
		return Date.now() - f.at > 2 ** f.tries * 60_000;
	}

	// which pending screenshots may go now
	function ready(pending, running, force) {
		const now = Date.now();
		const newestByApp = new Map();
		for (const s of pending) newestByApp.set(s.appid, Math.max(newestByApp.get(s.appid) || 0, s.mtimeMs));
		return pending.filter((s) => {
			if (!canRetry(s.key)) return false;
			if (force) return true;
			if (now - s.mtimeMs < SETTLE_MS) return false;
			if (cfg.when === 'immediately') return true;
			if (running.has(s.appid)) return false;
			// can't see which game runs: wait until no new screenshots for a while
			if (!detectable && now - newestByApp.get(s.appid) < QUIET_MS) return false;
			return true;
		});
	}

	async function uploadOne(s) {
		const file = path.join(s.dir, s.name);
		const data = fs.readFileSync(file);
		const size = jpegSize(data);
		if (!size) throw Object.assign(new Error('not a JPEG image'), { permanent: true });
		const thumbFile = path.join(s.dir, 'thumbnails', s.name);
		const thumb = fs.existsSync(thumbFile) ? fs.readFileSync(thumbFile) : (makeThumb(file) || data);
		const created = timeFromName(s.name) || Math.floor(s.mtimeMs / 1000);
		const { id, existed } = await uploadScreenshot(ctx.client, { appid: s.appid, name: s.name, data, thumb, ...size, created },
			{ privacy: cfg.privacy, debug: (m) => ctx.debug(m) });
		st.uploaded[s.key] = { at: Date.now(), id, existed: existed || undefined };
		delete st.failed[s.key];
		delete st.queued[s.key];
		st.count++;
		st.recent.unshift({ key: s.key, appid: s.appid, name: s.name, at: Date.now(), bytes: data.length, existed: existed || undefined });
		st.recent.length = Math.min(st.recent.length, RECENT_MAX);
		ctx.saveState();
		return existed;
	}

	// Game by game: the game you just closed first, then the others (newest screenshots first);
	// within a game, oldest screenshot first. Each game is announced as soon as it's done.
	const closedAt = new Map();   // appid -> when it was closed
	function byGameOrder(list) {
		const groups = new Map();
		for (const s of list) {
			if (!groups.has(s.appid)) groups.set(s.appid, []);
			groups.get(s.appid).push(s);
		}
		const newest = (g) => Math.max(...g.map((s) => s.mtimeMs));
		return [...groups.entries()]
			.sort(([a, ga], [b, gb]) => (closedAt.get(b) || 0) - (closedAt.get(a) || 0) || newest(gb) - newest(ga))
			.map(([, g]) => g.sort((x, y) => x.mtimeMs - y.mtimeMs));
	}

	async function uploadBatch(list) {
		busy = true;
		const privacyName = { private: 'private', friends: 'friends only', unlisted: 'unlisted', public: 'public' }[cfg.privacy];
		const games = byGameOrder(list);
		let already = 0;
		let done = 0;
		try {
			for (let gi = 0; gi < games.length; gi++) {
				const shots = games[gi];
				const appid = shots[0].appid;
				let n = 0;
				let stop = false;
				for (let i = 0; i < shots.length; i++) {
					const s = shots[i];
					if (!ctx.isLoggedIn()) { stop = true; break; }
					view.current = { game: gameName(appid), done: i, total: shots.length, gameNo: gi + 1, games: games.length, overall: done, overallTotal: list.length };
					done++;
					try {
						if (await uploadOne(s)) { already++; continue; }
						n++;
					} catch (err) {
						const f = st.failed[s.key] || { tries: 0 };
						st.failed[s.key] = { tries: err.permanent ? MAX_TRIES : f.tries + 1, at: Date.now(), error: err.message };
						ctx.saveState();
						ctx.debug(`upload ${s.key} failed: ${err.stack || err.message}`);
						ctx.log(`📷 Couldn't upload a ${gameName(appid)} screenshot (${s.name}): ${err.message}.${st.failed[s.key].tries >= MAX_TRIES ? '' : ' Will retry.'}`);
						if (/not connected|did not answer/i.test(err.message)) { stop = true; break; }
					}
				}
				if (n) ctx.log(`📷 Uploaded ${n} ${gameName(appid)} screenshot${n === 1 ? '' : 's'} to your Steam library (${privacyName}).`, true);
				closedAt.delete(appid);
				if (stop) break;
			}
		} finally {
			busy = false;
			view.current = null;
		}
		if (already) ctx.log(`📷 ${already} screenshot${already === 1 ? ' was' : 's were'} already in your Steam library, skipped.`);
	}

	// one check at a time; a check asked for meanwhile runs right after (so nothing is uploaded twice)
	let ticking = null;
	let again = null;   // null | { force }
	async function tick(force = false) {
		if (ticking) {
			again = { force: force || !!again?.force };
			return ticking;
		}
		ticking = check(force).finally(() => {
			ticking = null;
			if (again) { const f = again.force; again = null; tick(f).catch(() => {}); }
		});
		return ticking;
	}

	async function check(force) {
		if (!ctx.isLoggedIn()) { view.error = null; return; }
		try {
			if (!(await locate())) {
				view.error = steamDir ? 'No screenshots folder for this Steam account on this computer yet.' : "Couldn't find the Steam app's folder on this computer.";
				return;
			}
			view.error = null;
			const { pending, backlog, steamUploaded } = scan();
			const running = await runningApps();
			for (const appid of lastRunning) {
				if (running.has(appid)) continue;
				const n = pending.filter((s) => s.appid === appid).length;
				closedAt.set(appid, Date.now());
				if (n) ctx.log(`📷 ${gameName(appid)} closed. Uploading ${n} new screenshot${n === 1 ? '' : 's'}…`);
			}
			lastRunning = running;
			const go = ready(pending, running, force);
			Object.assign(view, {
				pending, backlog, steamUploaded, lastScanAt: Date.now(),
				waiting: pending.filter((s) => !go.includes(s) && canRetry(s.key)),
				running: [...running].map((appid) => ({ appid, name: gameName(appid) })),
			});
			if (go.length) {
				await uploadBatch(go);
				view.pending = view.pending.filter((s) => !st.uploaded[s.key]);
				view.waiting = view.waiting.filter((s) => !st.uploaded[s.key]);
			}
		} catch (err) {
			view.error = err.message;
			ctx.debug(`tick failed: ${err.stack || err.message}`);
		}
	}

	function start() {
		if (timer) return;
		timer = setInterval(() => tick().catch(() => {}), TICK_MS);
		setTimeout(() => tick().catch(() => {}), 3000);
	}
	function stop() { clearInterval(timer); timer = null; }

	function snapshot() {
		const steamid = ctx.steamID64();
		const failed = Object.entries(st.failed).filter(([, f]) => f.tries >= MAX_TRIES)
			.map(([key, f]) => ({ key, game: gameName(Number(key.split('/')[0])), file: key.split('/')[1], error: f.error }));
		return {
			folder: root,
			steamDir,
			error: view.error,
			canDetectGame: detectable,
			running: view.running,
			pending: view.pending.length,
			waiting: view.waiting.length,
			waitingGames: [...new Set(view.waiting.map((s) => s.appid))].map((appid) => gameName(appid)),
			backlog: view.backlog,
			steamUploaded: view.steamUploaded,
			uploaded: st.count,
			failed,
			current: view.current,
			busy,
			lastScanAt: view.lastScanAt,
			recent: st.recent.slice(0, 10).map((r) => ({ ...r, game: gameName(r.appid) })),
			libraryUrl: steamid ? `https://steamcommunity.com/profiles/${steamid}/screenshots/?sort=newestfirst&browsefilter=myfiles&view=grid&privacy=2` : null,
		};
	}

	const routes = {
		'POST settings'(body) {
			if (body.when === 'afterClose' || body.when === 'immediately') cfg.when = body.when;
			if (body.privacy in PRIVACY) cfg.privacy = body.privacy;
			if (typeof body.steamDir === 'string') { cfg.steamDir = body.steamDir.trim().slice(0, 500); root = null; lookedUpAt = 0; }
			ctx.saveConfig();
			tick().catch(() => {});
		},
		// upload everything waiting right now, even if the game is still running
		async 'POST upload-now'() {
			if (!ctx.isLoggedIn()) throw new Error('Log in first');
			await locate(true);
			if (!root) throw new Error(view.error || "Couldn't find your Steam screenshots folder");
			tick(true).catch(() => {});
		},
		// also upload screenshots from before the uploader was switched on
		// older screenshots (from before the uploader was on, not on Steam yet), grouped by game, newest first
		async 'GET older'() {
			await locate(true);
			if (!root) throw new Error(view.error || "Couldn't find your Steam screenshots folder");
			return { games: olderList() };
		},
		// a screenshot's thumbnail (or the full image with full=1), only from the screenshots folder
		async 'GET image'(q) {
			const key = String(q.key || '');
			if (!root || !/^\d+\/[\w .()-]+\.jpe?g$/i.test(key)) throw new Error('Bad screenshot');
			const [appid, name] = key.split('/');
			const dir = path.join(root, 'remote', appid, 'screenshots');
			const thumb = path.join(dir, 'thumbnails', name);
			const file = q.full === '1' || !fs.existsSync(thumb) ? path.join(dir, name) : thumb;
			if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) throw new Error('Bad screenshot');
			return { raw: true, type: 'image/jpeg', cache: 'private, max-age=3600', body: fs.readFileSync(file) };
		},
		// { keys: ["appid/file.jpg", ...] } - only these; without keys: every older screenshot
		async 'POST upload-older'(body) {
			if (!ctx.isLoggedIn()) throw new Error('Log in first');
			await locate(true);
			if (!root) throw new Error(view.error || "Couldn't find your Steam screenshots folder");
			const older = new Set(olderList().flatMap((g) => g.shots.map((x) => x.key)));
			const keys = Array.isArray(body?.keys) ? body.keys.filter((k) => older.has(k)) : [...older];
			for (const key of keys) st.queued[key] = true;
			ctx.saveState();
			const games = new Set(keys.map((k) => k.split('/')[0])).size;
			ctx.log(`📷 Queued ${keys.length} older screenshot${keys.length === 1 ? '' : 's'} from ${games} game${games === 1 ? '' : 's'} for upload.`);
			tick(true).catch(() => {});
			return { queued: keys.length };
		},
		'POST retry-failed'() {
			st.failed = {};
			ctx.saveState();
			tick(true).catch(() => {});
		},
		async 'POST open-folder'() {
			await locate(true);
			if (!root) throw new Error("Couldn't find your Steam screenshots folder");
			ctx.openPath(path.join(root, 'remote'));
		},
	};

	return {
		snapshot,
		routes,
		on: {
			loggedOn() { root = null; lookedUpAt = 0; start(); },
			stop,
		},
	};
}

module.exports = { create };
