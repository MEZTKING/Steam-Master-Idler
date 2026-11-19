'use strict';

// Tool: Launch options.
// Several launch option configs per game ("Default" = what Steam had when you first opened the game
// here, plus your own like "Performance" or "Streaming"), switched with one click. Steam keeps launch
// options in userdata/<account>/config/localconfig.vdf and rewrites that file when it closes, so a
// change is written either right away while Steam is closed, after closing and restarting Steam
// ("Apply now"), or as soon as you close Steam yourself ("Apply when Steam closes").
// Only the LaunchOptions value of that game is changed in the file; a copy of the file is kept first.

const fs = require('fs');
const path = require('path');
// used as steamLocal.x() so tests can stand in for the Steam app
const steamLocal = require('../../lib/steam-local');
const { findSteamDir, localConfigPath } = steamLocal;
const isSteamRunning = () => steamLocal.isSteamRunning();
const closeSteam = (dir) => steamLocal.closeSteam(dir);
const startSteam = (dir) => steamLocal.startSteam(dir);
const { getVdfValue, getVdfBlock, setVdfValue } = require('../../lib/vdf-edit');

const APPS_PATH = ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'];
const KEEP_BACKUPS = 10;
const WATCH_MS = 15_000;
const newId = () => Math.random().toString(36).slice(2, 10);
const DEFAULT_TEMPLATES = [
	{ name: 'Skip intro videos', options: '-novid' },
	{ name: 'High CPU priority', options: '-high' },
	{ name: 'DirectX 11', options: '-dx11' },
	{ name: 'DirectX 12', options: '-dx12' },
	{ name: 'Vulkan', options: '-vulkan' },
	{ name: 'Windowed, no border', options: '-windowed -noborder' },
];

function create(ctx) {
	const st = ctx.state;
	st.games ??= {};        // appid -> { defaultOptions, configs: [{ id, name, options }], active }
	st.pending ??= {};      // appid -> options waiting for Steam to close
	st.templates ??= DEFAULT_TEMPLATES.map((t) => ({ id: newId(), ...t }));
	st.history ??= [];
	let steamDir = null;
	let watcher = null;
	let busy = null;

	async function file() {
		const id = ctx.accountId();
		if (id == null) throw new Error('Log in first');
		steamDir = await findSteamDir(ctx.toolConfig('screenshots').steamDir || null, id);
		if (!steamDir) throw new Error("Couldn't find the Steam app on this computer.");
		const f = localConfigPath(steamDir, id);
		if (!fs.existsSync(f)) throw new Error('Steam has no settings file for this account on this computer yet (start a game once in Steam).');
		return f;
	}
	const read = async () => fs.readFileSync(await file(), 'utf8');

	// the game's entry; the first time, Steam's current launch options become its "Default"
	function game(appid, currentOptions) {
		const g = (st.games[appid] ??= { defaultOptions: currentOptions ?? '', configs: [], active: 'default' });
		return g;
	}
	const optionsOf = (g, id) => (id === 'default' ? g.defaultOptions : g.configs.find((c) => c.id === id)?.options);
	const activeFor = (g, current) => (current === g.defaultOptions ? 'default' : g.configs.find((c) => c.options === current)?.id || null);

	function backup(f) {
		const dir = path.join(ctx.dataDir, 'launch-option-backups');
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		fs.copyFileSync(f, path.join(dir, `localconfig-${ctx.accountId()}-${stamp}.vdf`));
		const old = fs.readdirSync(dir).filter((x) => x.startsWith(`localconfig-${ctx.accountId()}-`)).sort();
		for (const x of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.unlinkSync(path.join(dir, x));
	}

	// write { appid: options } into localconfig.vdf (Steam must be closed)
	async function write(changes) {
		const f = await file();
		let text = fs.readFileSync(f, 'utf8');
		backup(f);
		for (const [appid, options] of Object.entries(changes)) text = setVdfValue(text, [...APPS_PATH, String(appid)], 'LaunchOptions', options);
		const tmp = `${f}.smi-tmp`;
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, f);
		for (const [appid, options] of Object.entries(changes)) {
			const g = st.games[appid];
			if (g) g.active = activeFor(g, options);
			delete st.pending[appid];
			st.history.unshift({ at: Date.now(), appid: +appid, game: ctx.gameName(+appid), options });
		}
		st.history.length = Math.min(st.history.length, 20);
		ctx.saveState();
	}

	async function applyPending(restart) {
		if (!Object.keys(st.pending).length) return 0;
		busy = 'Closing Steam…';
		try {
			await file();   // finds steamDir
			if (await isSteamRunning()) {
				if (!restart) return 0;
				if (!(await closeSteam(steamDir))) throw new Error("Steam didn't close. Close it yourself and the change is applied right after.");
			}
			busy = 'Saving…';
			const changes = { ...st.pending };
			await write(changes);
			const names = Object.keys(changes).map((a) => ctx.gameName(+a)).join(', ');
			ctx.log(`🚀 Launch options set for ${names}.`, !restart);
			if (restart) { busy = 'Starting Steam…'; startSteam(steamDir); }
			return Object.keys(changes).length;
		} finally {
			busy = null;
			watch();
		}
	}

	// while changes wait: check every few seconds whether Steam has closed
	function watch() {
		const want = Object.keys(st.pending).length > 0;
		if (want && !watcher) {
			watcher = setInterval(async () => {
				if (busy) return;
				try { if (!(await isSteamRunning())) await applyPending(false); } catch (err) { ctx.debug(`apply: ${err.message}`); }
			}, WATCH_MS);
		}
		if (!want && watcher) { clearInterval(watcher); watcher = null; }
	}

	const cleanConfigs = (list) => (Array.isArray(list) ? list : []).slice(0, 50).map((c) => ({
		id: typeof c.id === 'string' && /^[a-z0-9]{4,12}$/.test(c.id) ? c.id : newId(), name: String(c.name || 'Config').slice(0, 60), options: String(c.options ?? '').slice(0, 2000),
	}));

	return {
		snapshot: () => ({ busy, pending: Object.keys(st.pending).length, games: Object.keys(st.games).length, history: st.history.slice(0, 5) }),
		routes: {
			async 'GET overview'() {
				const text = await read();
				const apps = getVdfBlock(text, APPS_PATH) || {};
				const current = (id) => { const a = Object.entries(apps).find(([k]) => k === String(id))?.[1]; return a && typeof a === 'object' ? Object.entries(a).find(([k]) => k.toLowerCase() === 'launchoptions')?.[1] ?? '' : ''; };
				const withOptions = Object.entries(apps).filter(([, a]) => typeof a === 'object' && Object.keys(a).some((k) => k.toLowerCase() === 'launchoptions' && a[k])).map(([id]) => +id);
				const ids = [...new Set([...Object.keys(st.games).map(Number), ...withOptions])];
				return {
					steamRunning: await isSteamRunning(),
					templates: st.templates,
					pending: st.pending,
					games: ids.map((id) => {
						const cur = current(id);
						const g = st.games[id];
						return { appid: id, name: ctx.gameName(id), current: cur, configs: g ? g.configs : [], defaultOptions: g ? g.defaultOptions : cur, active: g ? activeFor(g, cur) : 'default', pending: st.pending[id] ?? null };
					}).sort((a, b) => a.name.localeCompare(b.name)),
				};
			},
			async 'GET game'(q) {
				const appid = parseInt(q.appid, 10);
				if (!appid) throw new Error('Pick a game');
				const cur = getVdfValue(await read(), [...APPS_PATH, String(appid)], 'LaunchOptions') ?? '';
				const g = game(appid, cur);
				ctx.saveState();
				return { appid, name: ctx.gameName(appid), current: cur, defaultOptions: g.defaultOptions, configs: g.configs, active: activeFor(g, cur), pending: st.pending[appid] ?? null, steamRunning: await isSteamRunning() };
			},
			// { appid, configs: [{ id?, name, options }], defaultOptions? }
			'POST save'(body) {
				const appid = parseInt(body.appid, 10);
				const g = st.games[appid];
				if (!g) throw new Error('Open the game first');
				g.configs = cleanConfigs(body.configs);
				if (typeof body.defaultOptions === 'string') g.defaultOptions = body.defaultOptions.slice(0, 2000);
				ctx.saveState();
			},
			// { appid, config: 'default' | id, mode: 'now' | 'later' }
			async 'POST switch'(body) {
				const appid = parseInt(body.appid, 10);
				const g = st.games[appid];
				if (!g) throw new Error('Open the game first');
				const options = optionsOf(g, body.config);
				if (options == null) throw new Error('That config no longer exists');
				st.pending[appid] = options;
				ctx.saveState();
				if (!(await isSteamRunning())) { await applyPending(false); return { applied: true }; }
				if (body.mode === 'now') { await applyPending(true); return { applied: true, restarted: true }; }
				ctx.log(`🚀 ${ctx.gameName(appid)}: new launch options are applied as soon as you close Steam.`);
				watch();
				return { applied: false, waiting: true };
			},
			async 'POST apply-pending'(body) { return { applied: await applyPending(body?.mode === 'now') }; },
			'POST cancel-pending'(body) {
				if (body?.appid) delete st.pending[parseInt(body.appid, 10)]; else st.pending = {};
				ctx.saveState();
				watch();
			},
			'POST templates'(body) { st.templates = cleanConfigs(body.templates).slice(0, 30); ctx.saveState(); },
		},
		on: {
			loggedOn() { file().catch(() => {}); watch(); },
			stop() { if (watcher) clearInterval(watcher); watcher = null; },
		},
	};
}

module.exports = { create, APPS_PATH };
