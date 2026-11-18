'use strict';

// Steam tools that run next to the idler, sharing its Steam login. Every tool can be switched on and
// off on its own; a tool that's off isn't even loaded (no code, no timers, no requests to Steam).
//
// A tool is listed below with its metadata and default settings, and lives in src/tools/<id>/index.js:
//
//   module.exports = {
//     create(ctx) -> {
//       snapshot() -> object,              // small status, sent to the page every poll
//       routes: {                          // 'POST name' -> POST /api/tools/<id>/name
//         'POST settings'(body) {},        // 'GET name'  -> GET  /api/tools/<id>/name (bigger data the
//         'GET data'(query) {},            //                page asks for only while the tool is open)
//       },
//       on: { loggedOn(), stop() },        // optional lifecycle hooks; stop() runs when switched off
//     },
//   };
//
// ctx gives a tool: client (steam-user), log(msg, notify), debug(msg), config (its settings, saved
// in config.json under tools.<id>), state (its own object in state.json), saveConfig(), saveState(),
// toolState(id) / toolConfig(id) / callTool(id, method, action, body) for another tool,
// isLoggedIn(), accountId(), steamID64(), country(), web() -> { sessionID, cookies } | null,
// gameName(appid), gameIcon(appid), ownsApp(appid), playingElsewhere(), canSeePlaying(),
// withGamePlaying(appid, fn), openPath(dir), desktop, mobile.

const TOOLS = [
	{
		id: 'screenshots',
		icon: '📷',
		name: 'Screenshot uploader',
		description: 'Uploads the screenshots you take in games (F12) to your Steam library once you close the game. Private by default.',
		desktopOnly: 'Needs the Steam app on the same computer, so it only works in the desktop app.',
		defaults: { when: 'afterClose', privacy: 'private', steamDir: '' },
		load: () => require('./screenshots'),
	},
	{
		id: 'gallery',
		icon: '🗂',
		name: 'Screenshot manager',
		description: 'All your Steam screenshots in one gallery: like or dislike them, back up the ones you like, move the rest to a trash you can restore from.',
		desktopOnly: 'Needs the Steam app on the same computer, so it only works in the desktop app.',
		defaults: { autoBackup: 'liked', folder: '' },
		load: () => require('./gallery'),
	},
	{
		id: 'achievements',
		icon: '🏆',
		name: 'Achievement manager',
		description: 'See every achievement of a game and unlock or lock them, like Steam Achievement Manager.',
		defaults: {},
		load: () => require('./achievements'),
	},
	{
		id: 'wishlist',
		icon: '🏷',
		name: 'Wishlist sale alerts',
		description: 'Checks your wishlist and notifies you when a game goes on sale, drops below your price, is free to play or keep, or may be delisted soon.',
		defaults: { minDiscount: 50, everyHours: 6, delistWatch: false, freeAlerts: true },
		load: () => require('./wishlist'),
	},
	{
		id: 'sale',
		icon: '🎁',
		name: 'Sale event helper',
		description: 'During Steam sales: clears your Discovery Queue and claims the free daily sticker, once a day.',
		defaults: { queues: 1, sticker: true, queue: true },
		load: () => require('./sale'),
	},
	{
		id: 'freegames',
		icon: '🆓',
		name: 'Free game claimer',
		description: 'Paste a store link or AppID of a free (or free-to-keep) game and it is added to your account.',
		defaults: {},
		load: () => require('./freegames'),
	},
	{
		id: 'badges',
		icon: '🃏',
		name: 'Badges & boosters',
		description: 'Your badge progress per game, a notification when a badge can be crafted, and the booster packs you can make with gems. Read-only.',
		defaults: { notifyCraft: true, boosters: true },
		load: () => require('./badges'),
	},
	{
		id: 'playtime',
		icon: '📊',
		name: 'Playtime reports',
		description: 'A day-by-day history of what you played (and idled), a weekly summary on Monday, and games from your library worth trying.',
		defaults: { weekly: true },
		load: () => require('./playtime'),
	},
	{
		id: 'cleanup',
		icon: '🧹',
		name: 'Library cleanup',
		description: "Games you never played or barely touched, games you can still refund, and DLC for games you don't own.",
		defaults: { barelyMinutes: 30 },
		load: () => require('./cleanup'),
	},
	{
		id: 'market',
		icon: '💰',
		name: 'Market value',
		description: 'What your trading cards, backgrounds, emoticons and boosters are worth on the Steam Market. Read-only: nothing is listed or sold.',
		defaults: {},
		load: () => require('./market'),
	},
	{
		id: 'backups',
		icon: '💾',
		name: 'Backups',
		description: 'Saves your playtime and achievements (and copies new screenshots) to a folder, daily or weekly.',
		defaults: { folder: '', every: 'weekly', keep: 10, achievements: true, allAchievements: false, screenshots: false, notify: false },
		load: () => require('./backups'),
	},
	{
		id: 'profile',
		icon: '🖼',
		name: 'Profile rotator',
		description: 'Changes your profile background, mini-profile, avatar frame or animated avatar on a schedule, from the items you own.',
		defaults: { everyHours: 24, order: 'random', slots: { background: true, mini: false, frame: false, avatar: false }, notify: false },
		load: () => require('./profile'),
	},
];

function createTools(host) {
	host.config.tools ??= {};
	host.state.tools ??= {};
	const running = new Map();   // id -> instance (only switched-on tools)

	const meta = (def) => ({ id: def.id, icon: def.icon, name: def.name, description: def.description });
	const config = (def) => (host.config.tools[def.id] = Object.assign({ enabled: false }, def.defaults, host.config.tools[def.id]));
	const availability = (def) => (def.desktopOnly && host.shared.mobile ? { ok: false, reason: def.desktopOnly } : { ok: true });
	for (const def of TOOLS) config(def);

	function start(def, justEnabled = false) {
		if (running.has(def.id) || !availability(def).ok) return running.get(def.id);
		const state = host.state.tools[def.id] ??= {};
		const ctx = {
			...host.shared,
			id: def.id,
			justEnabled,
			config: config(def),
			state,
			log: (msg, notify) => host.log(msg, notify),
			debug: (msg) => host.debugLog.write(def.id, msg),
			// another tool's saved state / settings (read them, don't replace them), and its actions
			toolState: (id) => (host.state.tools[id] ??= {}),
			toolConfig: (id) => host.config.tools[id] || {},
			callTool: (id, method, action, body) => route(method, id, action, body),
		};
		const inst = def.load().create(ctx);
		running.set(def.id, inst);
		host.debugLog.write('tools', `${def.id} on`);
		if (host.shared.isLoggedIn()) safe(def, inst, 'loggedOn');
		return inst;
	}

	function stop(def) {
		const inst = running.get(def.id);
		if (!inst) return;
		running.delete(def.id);
		safe(def, inst, 'stop');
		host.debugLog.write('tools', `${def.id} off`);
	}

	function safe(def, inst, event, ...args) {
		try { inst.on?.[event]?.(...args); } catch (err) { host.debugLog.write(def.id, `${event} hook failed: ${err.stack || err.message}`); }
	}

	// switched-on tools start with the app
	for (const def of TOOLS) if (config(def).enabled) {
		try { start(def); } catch (err) { host.debugLog.write(def.id, `couldn't start: ${err.stack || err.message}`); }
	}

	function enable(def, on) {
		const cfg = config(def);
		if (on && !availability(def).ok) throw new Error(availability(def).reason);
		if (on === cfg.enabled && on === running.has(def.id)) return;
		cfg.enabled = on;
		host.shared.saveConfig();
		if (on) { start(def, true); host.log(`${def.icon} ${def.name} on.`); } else { stop(def); host.log(`${def.icon} ${def.name} off.`); }
	}

	// POST|GET /api/tools/<id>/<action>
	async function route(method, id, action, body) {
		const def = TOOLS.find((t) => t.id === id);
		if (!def) throw Object.assign(new Error('No such tool'), { status: 404 });
		if (method === 'POST' && action === 'enable') return enable(def, !!body.enabled);
		const inst = running.get(id);
		const fn = inst?.routes?.[`${method} ${action}`];
		if (!fn) {
			if (!inst) throw new Error(`Switch ${def.name} on first.`);
			throw Object.assign(new Error('Unknown action'), { status: 404 });
		}
		return fn(body);
	}

	return {
		route,
		snapshot: () => TOOLS.map((def) => {
			const avail = availability(def);
			const inst = running.get(def.id);
			return { ...meta(def), enabled: !!inst, available: avail.ok, reason: avail.reason || null, settings: config(def), ...(inst ? inst.snapshot() : {}) };
		}),
		emit(event, ...args) {
			for (const def of TOOLS) { const inst = running.get(def.id); if (inst) safe(def, inst, event, ...args); }
		},
	};
}

module.exports = { createTools };
