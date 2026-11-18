'use strict';

// Tool: Screenshot manager.
// A gallery of every screenshot the Steam app keeps on this computer
// (userdata/<id>/760/remote/<appid>/screenshots), with your own ratings:
//   👍 liked / 👎 disliked / unrated, kept in state.json (Steam's files are never edited for this)
// and what you can do with them:
//   - back up liked (or all) screenshots into <folder>/<Game>/, automatically or on demand
//   - move screenshots to a trash folder (<folder>/.trash) and restore them; emptying the trash
//     is the only thing that deletes files, and it asks first
//   - upload them (through the Screenshot uploader), or remove ones already on Steam from your
//     Steam screenshot library

const fs = require('fs');
const path = require('path');
const { findSteamDir, screenshotsRoot } = require('../../lib/steam-local');
const { parseVdf } = require('../../lib/vdf');
const { sendMsg, EMsg, EResult } = require('../../lib/steam-cm');
const { jpegSize } = require('../screenshots/uploader');

// Steam's screenshot size limits (the largest it accepts): 16000 px a side, 26,210,175 pixels in all
const MAX_SIDE = 16000;
const MAX_PIXELS = 26210175;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stampName = (t) => { const d = new Date(t); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };

const NON_STEAM = 0x80000000;
const UNSET = new Set(['', '0', '18446744073709551615']);
const KEY_RE = /^\d+\/[\w .()-]+\.jpe?g$/i;
const BACKUP_SCAN_MS = 60 * 60_000;
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[\s.]+$/, '').slice(0, 80) || 'Unknown';

// 20240131235959_1.jpg -> ms (local time), else null
function takenFromName(name) {
	const m = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
	if (!m) return null;
	const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
	return Number.isFinite(t) ? t : null;
}

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.ratings ??= {};     // key -> 1 (liked) | -1 (disliked)
	st.trash ??= {};       // key -> { at, game }
	st.backedUp ??= {};    // key -> size copied
	let root = null;
	let lookedUpAt = 0;
	let timer = null;
	let busy = null;       // { what, done, total }
	let backupSoon = null;

	const folder = () => cfg.folder || path.join(ctx.dataDir, 'screenshot-backups');
	const trashDir = () => path.join(folder(), '.trash');
	const shotsDir = (appid) => path.join(root, 'remote', String(appid), 'screenshots');
	const gameDir = (appid) => path.join(folder(), safeName(ctx.gameName(+appid)));

	async function locate(force = false) {
		if (!force && root && Date.now() - lookedUpAt < 5 * 60_000) return root;
		lookedUpAt = Date.now();
		const id = ctx.accountId();
		if (id == null) return null;
		const steamDir = await findSteamDir(ctx.toolConfig('screenshots').steamDir || null, id);
		const r = steamDir && screenshotsRoot(steamDir, id);
		root = r && fs.existsSync(r) ? r : null;
		return root;
	}

	// screenshots Steam knows as uploaded (screenshots.vdf), with their library handle when it has one
	function steamInfo() {
		const out = new Map();   // key -> { uploaded, handle }
		try {
			const vdf = parseVdf(fs.readFileSync(path.join(root, 'screenshots.vdf'), 'utf8'));
			const shots = Object.entries(vdf).find(([k]) => k.toLowerCase() === 'screenshots')?.[1] || {};
			for (const [appid, entries] of Object.entries(shots)) {
				if (!/^\d+$/.test(appid) || typeof entries !== 'object') continue;
				for (const e of Object.values(entries)) {
					if (typeof e !== 'object' || !e.filename) continue;
					const pub = String(e.publishedfileid ?? '');
					const handle = String(e.hscreenshot ?? '');
					out.set(`${appid}/${path.basename(e.filename)}`, { uploaded: !UNSET.has(pub) || !UNSET.has(String(e.ugchandle ?? '')), handle: UNSET.has(handle) ? null : handle });
				}
			}
		} catch { /* no screenshots.vdf yet */ }
		return out;
	}

	// every screenshot on disk (plus the ones in our trash)
	function list() {
		const up = ctx.toolState('screenshots').uploaded || {};
		const info = steamInfo();
		const shots = [];
		let dirs = [];
		try { dirs = fs.readdirSync(path.join(root, 'remote')).filter((d) => /^\d+$/.test(d) && Number(d) < NON_STEAM); } catch { /* none */ }
		for (const d of dirs) {
			let files = [];
			try { files = fs.readdirSync(shotsDir(d)).filter((f) => /\.jpe?g$/i.test(f)); } catch { continue; }
			for (const f of files) {
				const key = `${d}/${f}`;
				let s;
				try { s = fs.statSync(path.join(shotsDir(d), f)); } catch { continue; }
				const i = info.get(key);
				shots.push({
					key, appid: +d, name: f, size: s.size, takenAt: takenFromName(f) || s.mtimeMs,
					rating: st.ratings[key] || 0,
					onSteam: !!(up[key] || i?.uploaded), steamId: up[key]?.id || i?.handle || null,
					backedUp: st.backedUp[key] === s.size, trashed: false,
				});
			}
		}
		for (const [key, t] of Object.entries(st.trash)) {
			const [appid, name] = key.split('/');
			if (!fs.existsSync(path.join(trashDir(), appid, name))) { delete st.trash[key]; continue; }
			shots.push({ key, appid: +appid, name, size: 0, takenAt: takenFromName(name) || t.at, rating: st.ratings[key] || 0, onSteam: !!up[key], steamId: up[key]?.id || null, backedUp: false, trashed: true, trashedAt: t.at });
		}
		return shots;
	}

	const fileOf = (key, trashed) => {
		const [appid, name] = key.split('/');
		return trashed ? path.join(trashDir(), appid, name) : path.join(shotsDir(appid), name);
	};

	// copy screenshots into <folder>/<Game>/ (once; a changed file is copied again)
	function backup(keys) {
		let copied = 0;
		for (const key of keys) {
			const [appid, name] = key.split('/');
			const src = path.join(shotsDir(appid), name);
			let size;
			try { size = fs.statSync(src).size; } catch { continue; }
			if (st.backedUp[key] === size) continue;
			const dest = path.join(gameDir(appid), name);
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
			st.backedUp[key] = size;
			copied++;
		}
		if (copied) ctx.saveState();
		return copied;
	}

	// the automatic backup: liked ones, or every screenshot
	function autoBackup() {
		if (cfg.autoBackup === 'off' || !root) return 0;
		const keys = list().filter((s) => !s.trashed && !s.backedUp && (cfg.autoBackup === 'all' ? s.rating >= 0 : s.rating === 1)).map((s) => s.key);
		const n = backup(keys);
		if (n) ctx.log(`🗂 Backed up ${n} screenshot${n === 1 ? '' : 's'} to ${folder()}.`);
		return n;
	}
	const scheduleBackup = () => { clearTimeout(backupSoon); backupSoon = setTimeout(() => { try { autoBackup(); } catch (err) { ctx.debug(`backup: ${err.message}`); } }, 5000); };

	function moveTo(src, dest) {
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		try { fs.renameSync(src, dest); } catch (err) {
			if (err.code !== 'EXDEV') throw err;   // different drive: copy, then remove
			fs.copyFileSync(src, dest);
			fs.unlinkSync(src);
		}
	}

	function trash(keys) {
		let n = 0;
		for (const key of keys) {
			if (st.trash[key]) continue;
			const [appid, name] = key.split('/');
			const src = path.join(shotsDir(appid), name);
			if (!fs.existsSync(src)) continue;
			moveTo(src, path.join(trashDir(), appid, name));
			const thumb = path.join(shotsDir(appid), 'thumbnails', name);
			if (fs.existsSync(thumb)) moveTo(thumb, path.join(trashDir(), appid, 'thumbnails', name));
			st.trash[key] = { at: Date.now(), game: ctx.gameName(+appid) };
			n++;
		}
		ctx.saveState();
		return n;
	}

	function restore(keys) {
		let n = 0;
		for (const key of keys) {
			if (!st.trash[key]) continue;
			const [appid, name] = key.split('/');
			const from = path.join(trashDir(), appid, name);
			if (fs.existsSync(from)) moveTo(from, path.join(shotsDir(appid), name));
			const thumb = path.join(trashDir(), appid, 'thumbnails', name);
			if (fs.existsSync(thumb)) moveTo(thumb, path.join(shotsDir(appid), 'thumbnails', name));
			delete st.trash[key];
			n++;
		}
		ctx.saveState();
		return n;
	}

	function emptyTrash(keys) {
		let n = 0;
		for (const key of keys || Object.keys(st.trash)) {
			if (!st.trash[key]) continue;
			const [appid, name] = key.split('/');
			for (const f of [path.join(trashDir(), appid, name), path.join(trashDir(), appid, 'thumbnails', name)]) { try { fs.unlinkSync(f); } catch { /* gone */ } }
			delete st.trash[key];
			delete st.ratings[key];
			delete st.backedUp[key];
			n++;
		}
		ctx.saveState();
		return n;
	}

	async function removeFromSteam(shots) {
		let n = 0;
		const errors = [];
		for (const s of shots) {
			if (!s.steamId) continue;
			try {
				const r = await sendMsg(ctx.client, EMsg.ClientUCMDeleteScreenshot, 'CMsgClientUCMDeleteScreenshot', 'CMsgClientUCMDeleteScreenshotResponse',
					{ screenshotid: s.steamId }, { timeoutMs: 20_000 });
				if (r.eresult !== EResult.OK && r.eresult !== EResult.FileNotFound) throw new Error(EResult[r.eresult] || r.eresult);
				const up = ctx.toolState('screenshots').uploaded;
				if (up?.[s.key]) up[s.key].removedFromSteam = Date.now();
				n++;
			} catch (err) {
				errors.push(`${s.name}: ${err.message}`);
			}
		}
		ctx.saveState();
		return { removed: n, errors };
	}

	const keysOf = (body) => (Array.isArray(body?.keys) ? body.keys.filter((k) => KEY_RE.test(k)) : []);
	async function ready() {
		if (!(await locate())) throw new Error("Couldn't find the Steam app's screenshots folder on this computer.");
	}

	function schedule() {
		clearTimeout(timer);
		if (cfg.autoBackup !== 'all') return;
		timer = setTimeout(() => { try { autoBackup(); } catch (err) { ctx.debug(`backup: ${err.message}`); } schedule(); }, BACKUP_SCAN_MS);
	}

	return {
		snapshot: () => ({
			busy, folder: folder(),
			liked: Object.values(st.ratings).filter((r) => r === 1).length,
			disliked: Object.values(st.ratings).filter((r) => r === -1).length,
			inTrash: Object.keys(st.trash).length,
			backedUp: Object.keys(st.backedUp).length,
		}),
		routes: {
			async 'GET list'() {
				await ready();
				const shots = list();
				const games = {};
				for (const s of shots) games[s.appid] ??= ctx.gameName(s.appid);
				return { shots, games };
			},
			async 'GET image'(q) {
				const key = String(q.key || '');
				if (!KEY_RE.test(key)) throw new Error('Bad screenshot');
				await ready();
				const trashed = !!st.trash[key];
				const [appid, name] = key.split('/');
				const base = trashed ? path.join(trashDir(), appid) : shotsDir(appid);
				const thumb = path.join(base, 'thumbnails', name);
				const file = q.full === '1' || !fs.existsSync(thumb) ? path.join(base, name) : thumb;
				const allowed = [path.resolve(root), path.resolve(trashDir())];
				if (!allowed.some((dir) => path.resolve(file).startsWith(dir + path.sep))) throw new Error('Bad screenshot');
				return { raw: true, type: 'image/jpeg', cache: 'private, max-age=600', body: fs.readFileSync(file) };
			},
			// { keys, rating: 1 | -1 | 0 }
			'POST rate'(body) {
				const r = [1, -1, 0].includes(+body.rating) ? +body.rating : 0;
				const keys = keysOf(body);
				for (const k of keys) { if (r) st.ratings[k] = r; else delete st.ratings[k]; }
				ctx.saveState();
				if (r === 1 || cfg.autoBackup === 'all') scheduleBackup();
				return { rated: keys.length };
			},
			async 'POST backup'(body) {
				await ready();
				const keys = keysOf(body);
				const n = backup(keys.length ? keys : list().filter((s) => !s.trashed && s.rating === 1).map((s) => s.key));
				ctx.log(`🗂 Backed up ${n} screenshot${n === 1 ? '' : 's'} to ${folder()}.`);
				return { copied: n };
			},
			async 'POST trash'(body) {
				await ready();
				const n = trash(keysOf(body));
				ctx.log(`🗂 Moved ${n} screenshot${n === 1 ? '' : 's'} to the trash (${trashDir()}). You can restore them.`);
				return { moved: n };
			},
			async 'POST restore'(body) {
				await ready();
				const n = restore(keysOf(body));
				ctx.log(`🗂 Restored ${n} screenshot${n === 1 ? '' : 's'}.`);
				return { restored: n };
			},
			async 'POST empty-trash'(body) {
				const keys = keysOf(body);
				const n = emptyTrash(keys.length ? keys : null);
				ctx.log(`🗂 Deleted ${n} screenshot${n === 1 ? '' : 's'} from the trash for good.`);
				return { deleted: n };
			},
			// upload through the Screenshot uploader (which tracks what's on Steam)
			async 'POST upload'(body) {
				const keys = keysOf(body);
				return ctx.callTool('screenshots', 'POST', 'upload-older', { keys });
			},
			async 'POST remove-from-steam'(body) {
				if (!ctx.isLoggedIn()) throw new Error('Log in first');
				await ready();
				const want = new Set(keysOf(body));
				const r = await removeFromSteam(list().filter((s) => want.has(s.key)));
				ctx.log(`🗂 Removed ${r.removed} screenshot${r.removed === 1 ? '' : 's'} from your Steam library.${r.errors.length ? ` ${r.errors.length} failed.` : ''}`);
				if (r.errors.length && !r.removed) throw new Error(r.errors[0]);
				return r;
			},
			'POST settings'(body) {
				if (['off', 'liked', 'all'].includes(body.autoBackup)) cfg.autoBackup = body.autoBackup;
				if (typeof body.folder === 'string') {
					const f = body.folder.trim();
					if (f && !path.isAbsolute(f)) throw new Error('Use a full folder path, like D:\\Screenshots or /home/me/screenshots');
					if (f !== cfg.folder && Object.keys(st.trash).length) throw new Error('Empty or restore the trash before changing the folder.');
					cfg.folder = f;
					st.backedUp = {};   // the new folder starts empty
					ctx.saveState();
				}
				ctx.saveConfig();
				schedule();
				scheduleBackup();
			},
			// the resolution most of a game's screenshots have (what "same as my screenshots" sizes to)
			async 'GET import-info'(q) {
				await ready();
				const appid = parseInt(q.appid, 10);
				const counts = new Map();
				let files = [];
				try { files = fs.readdirSync(shotsDir(appid)).filter((f) => /\.jpe?g$/i.test(f)).slice(-200); } catch { /* no screenshots for it yet */ }
				for (const f of files) {
					try {
						const fd = fs.openSync(path.join(shotsDir(appid), f), 'r');
						const head = Buffer.alloc(65536);
						fs.readSync(fd, head, 0, head.length, 0);
						fs.closeSync(fd);
						const sz = jpegSize(head);
						if (sz) counts.set(`${sz.width}x${sz.height}`, (counts.get(`${sz.width}x${sz.height}`) || 0) + 1);
					} catch { /* skip */ }
				}
				const best = [...counts].sort((a, b) => b[1] - a[1])[0];
				return { maxSide: MAX_SIDE, maxPixels: MAX_PIXELS, common: best ? { width: +best[0].split('x')[0], height: +best[0].split('x')[1], count: best[1], of: files.length } : null };
			},
			// { appid, takenAt, image: base64 JPEG, thumb: base64 JPEG } -> saved as a Steam screenshot of that game
			async 'POST import'(body) {
				await ready();
				const appid = parseInt(body.appid, 10);
				if (!appid || appid >= NON_STEAM) throw new Error('Pick a game');
				const image = Buffer.from(String(body.image || ''), 'base64');
				const size = jpegSize(image);
				if (!size) throw new Error('That image could not be converted to JPEG.');
				if (size.width > MAX_SIDE || size.height > MAX_SIDE || size.width * size.height > MAX_PIXELS) throw new Error(`${size.width}×${size.height} is bigger than Steam accepts.`);
				const thumb = body.thumb ? Buffer.from(String(body.thumb), 'base64') : null;
				const dir = shotsDir(appid);
				fs.mkdirSync(path.join(dir, 'thumbnails'), { recursive: true });
				// Steam's naming: when it was taken, then _1, _2, ... for the same second
				const base = stampName(Number(body.takenAt) || Date.now());
				let n = 1;
				while (fs.existsSync(path.join(dir, `${base}_${n}.jpg`))) n++;
				const name = `${base}_${n}.jpg`;
				fs.writeFileSync(path.join(dir, name), image);
				if (thumb && jpegSize(thumb)) fs.writeFileSync(path.join(dir, 'thumbnails', name), thumb);
				const key = `${appid}/${name}`;
				ctx.debug(`imported ${key} ${size.width}x${size.height} ${image.length} bytes`);
				return { key, name, ...size };
			},
			'POST open-folder'() { fs.mkdirSync(folder(), { recursive: true }); ctx.openPath(folder()); },
		},
		on: {
			async loggedOn() { await locate(true).catch(() => {}); schedule(); scheduleBackup(); },
			stop() { clearTimeout(timer); clearTimeout(backupSoon); timer = backupSoon = null; },
		},
	};
}

module.exports = { create };
