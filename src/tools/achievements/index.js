'use strict';

// Tool: Achievement manager (like Steam Achievement Manager).
// Loads a game's achievements straight from Steam (ClientGetUserStats: the stats schema + your
// progress) and unlocks or locks them (ClientStoreUserStats2), through the idler's own login, so the
// Steam app doesn't need to run. Achievements live as bits of "achievement" stats; changing one
// means storing the new stat value. Unlocks can also be spread out: one every N minutes.

const { sendMsg, EMsg, EResult } = require('../../lib/steam-cm');
const { parseBinaryKv } = require('../../lib/binkv');

const ICON_BASE = 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps';
const STAT_ACHIEVEMENTS = 4;
const STAT_GROUP_ACHIEVEMENTS = 5;

const text = (v, lang = 'english') => (v == null ? '' : typeof v === 'object' ? (v[lang] ?? v.english ?? Object.values(v)[0] ?? '') : String(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStats(client, steamID64, appid) {
	const res = await sendMsg(client, EMsg.ClientGetUserStats, 'CMsgClientGetUserStats', 'CMsgClientGetUserStatsResponse', {
		game_id: String(appid), crc_stats: 0, schema_local_version: -1, steam_id_for_user: steamID64,
	}, { untagged: { emsg: EMsg.ClientGetUserStatsResponse, match: (r) => String(r.game_id) === String(appid) } });
	if (res.eresult !== EResult.OK) {
		throw new Error(res.eresult === EResult.Fail || res.eresult === EResult.InvalidParam
			? "This game has no achievements (or Steam doesn't share them)."
			: `Steam couldn't load the achievements: ${EResult[res.eresult] || res.eresult}`);
	}
	return res;
}

function parse(appid, res, fallbackName) {
	const kv = res.schema?.length ? parseBinaryKv(res.schema) : {};
	const root = kv[String(appid)] || Object.values(kv)[0] || {};
	const values = new Map((res.stats || []).map((s) => [s.stat_id, s.stat_value >>> 0]));
	const times = new Map((res.achievement_blocks || []).map((b) => [b.achievement_id, b.unlock_time || []]));
	const list = [];
	for (const [statKey, stat] of Object.entries(root.stats || {})) {
		const type = Number(stat.type_int ?? stat.type);
		if (type !== STAT_ACHIEVEMENTS && type !== STAT_GROUP_ACHIEVEMENTS) continue;
		const statId = Number(stat.id ?? statKey);
		for (const [bitKey, a] of Object.entries(stat.bits || {})) {
			const bit = Number(a.bit ?? bitKey);
			const d = a.display || {};
			const icon = d.icon ? `${ICON_BASE}/${appid}/${d.icon}` : null;
			const unlocked = ((values.get(statId) || 0) >>> bit & 1) === 1;
			const t = times.get(statId)?.[bit] || 0;
			list.push({
				id: `${statId}_${bit}`, statId, bit,
				apiName: a.name || '',
				name: text(d.name) || a.name || `Achievement ${statId}/${bit}`,
				desc: text(d.desc),
				hidden: String(d.hidden) === '1',
				icon: unlocked ? icon : (d.icon_gray ? `${ICON_BASE}/${appid}/${d.icon_gray}` : icon),
				// protected achievements can only be set by the game's own servers
				protected: (Number(a.permission || stat.permission || 0) & 3) !== 0,
				unlocked,
				unlockedAt: unlocked && t ? t * 1000 : null,
			});
		}
	}
	return { appid, name: text(root.gamename) || fallbackName || `App ${appid}`, crc: res.crc_stats, values, achievements: list };
}


// a game's achievements with your progress: { appid, name, crc, values, achievements: [...] }
async function loadAchievements(client, steamID64, appid, name) {
	return parse(appid, await fetchStats(client, steamID64, appid), name);
}

function create(ctx) {
	const st = ctx.state;
	st.queue ??= [];        // gradual unlocks: [{ appid, statId, bit, name }]
	st.everyMinutes ??= 0;
	st.history ??= [];
	let busy = false;
	let lastGame = null;    // only the game open in the page is kept in memory
	let queueTimer = null;

	const me = () => ctx.steamID64();

	async function load(appid) {
		const game = await loadAchievements(ctx.client, me(), appid, ctx.gameName(appid));
		lastGame = game;
		return game;
	}

	const view = (g) => ({
		appid: g.appid, name: g.name, achievements: g.achievements,
		unlocked: g.achievements.filter((a) => a.unlocked).length, total: g.achievements.length,
		queued: st.queue.filter((q) => q.appid === g.appid).map((q) => `${q.statId}_${q.bit}`),
	});

	async function store(appid, crc, stats) {
		const body = { game_id: String(appid), settor_steam_id: me(), settee_steam_id: me(), crc_stats: crc, explicit_reset: false, stats };
		const send = () => sendMsg(ctx.client, EMsg.ClientStoreUserStats2, 'CMsgClientStoreUserStats2', 'CMsgClientStoreUserStatsResponse', body,
			{ untagged: { emsg: EMsg.ClientStoreUserStatsResponse, match: (r) => String(r.game_id) === String(appid) } });
		let res = await send().catch((err) => ({ eresult: -1, err }));
		if (res.eresult !== EResult.OK) {
			// Steam may only accept stats from a session that is in the game: play it briefly and try again
			ctx.debug(`store ${appid} not accepted (${res.err?.message || EResult[res.eresult]}), retrying while in-game`);
			res = await ctx.withGamePlaying(appid, send);
		}
		if (res.eresult !== EResult.OK) throw new Error(`Steam didn't accept the change: ${EResult[res.eresult] || res.eresult}`);
		if (res.stats_failed_validation?.length) throw new Error('Steam rejected some of the changes (protected by the game).');
	}

	// changes: [{ statId, bit, unlocked }]
	async function apply(appid, changes) {
		if (busy) throw new Error('Busy with another change, try again in a moment.');
		busy = true;
		try {
			const game = await load(appid);   // always start from Steam's current values
			const values = new Map(game.values);
			const byId = new Map(game.achievements.map((a) => [a.id, a]));
			let n = 0;
			let unlocked = 0;
			for (const c of changes) {
				const a = byId.get(`${c.statId}_${c.bit}`);
				if (!a || a.protected || a.unlocked === !!c.unlocked) continue;
				const v = values.get(a.statId) || 0;
				values.set(a.statId, (c.unlocked ? (v | (1 << a.bit)) : (v & ~(1 << a.bit))) >>> 0);
				n++;
				if (c.unlocked) unlocked++;
			}
			if (!n) return view(game);
			const stats = [...values].filter(([id, v]) => game.values.get(id) !== v).map(([stat_id, stat_value]) => ({ stat_id, stat_value }));
			await store(appid, game.crc, stats);
			ctx.log(`🏆 ${game.name}: ${unlocked ? `unlocked ${unlocked}` : ''}${unlocked && n - unlocked ? ', ' : ''}${n - unlocked ? `locked ${n - unlocked}` : ''} achievement${n === 1 ? '' : 's'}.`);
			st.history.unshift({ appid, game: game.name, unlocked, locked: n - unlocked, at: Date.now() });
			st.history.length = Math.min(st.history.length, 20);
			ctx.saveState();
			await sleep(800);
			return view(await load(appid));
		} finally {
			busy = false;
		}
	}

	// gradual unlocking: one queued achievement every st.everyMinutes
	function scheduleQueue() {
		clearTimeout(queueTimer);
		queueTimer = null;
		if (!st.queue.length || !st.everyMinutes) return;
		const wait = Math.max(5_000, (st.nextAt || 0) - Date.now());
		queueTimer = setTimeout(runQueue, wait);
	}
	async function runQueue() {
		const q = st.queue[0];
		if (!q) return;
		if (!ctx.isLoggedIn() || busy) { st.nextAt = Date.now() + 60_000; return scheduleQueue(); }
		try {
			await apply(q.appid, [{ statId: q.statId, bit: q.bit, unlocked: true }]);
			st.queue.shift();
		} catch (err) {
			q.tries = (q.tries || 0) + 1;
			ctx.log(`🏆 Couldn't unlock "${q.name}": ${err.message}${q.tries >= 3 ? ' Skipped.' : ' Will retry.'}`);
			if (q.tries >= 3) st.queue.shift();
		}
		st.nextAt = Date.now() + st.everyMinutes * 60_000;
		ctx.saveState();
		if (!st.queue.length) ctx.log('🏆 All queued achievements are unlocked.', true);
		scheduleQueue();
	}

	return {
		snapshot: () => ({
			busy,
			queue: st.queue.length,
			queueGames: [...new Set(st.queue.map((q) => q.game))],
			everyMinutes: st.everyMinutes,
			nextAt: st.queue.length && st.everyMinutes ? st.nextAt || null : null,
			history: st.history.slice(0, 5),
		}),
		routes: {
			async 'GET game'(q) {
				const appid = parseInt(q.appid, 10);
				if (!appid) throw new Error('Pick a game');
				if (!ctx.isLoggedIn()) throw new Error('Log in first');
				if (lastGame?.appid === appid && q.cached === '1') return view(lastGame);
				return view(await load(appid));
			},
			// { appid, changes: [{ id: "statId_bit", unlocked }] }
			async 'POST apply'(body) {
				const appid = parseInt(body.appid, 10);
				if (!appid || !Array.isArray(body.changes)) throw new Error('Nothing to change');
				if (!ctx.isLoggedIn()) throw new Error('Log in first');
				const changes = body.changes.map((c) => { const [statId, bit] = String(c.id).split('_').map(Number); return { statId, bit, unlocked: !!c.unlocked }; });
				return apply(appid, changes);
			},
			// { appid, ids: ["statId_bit", ...], everyMinutes }
			async 'POST schedule'(body) {
				const appid = parseInt(body.appid, 10);
				const every = Math.max(1, Math.min(24 * 60, parseInt(body.everyMinutes, 10) || 0));
				const game = lastGame?.appid === appid ? lastGame : await load(appid);
				const want = new Set(body.ids || []);
				const add = game.achievements.filter((a) => want.has(a.id) && !a.unlocked && !a.protected
					&& !st.queue.some((q) => q.appid === appid && q.statId === a.statId && q.bit === a.bit));
				for (const a of add) st.queue.push({ appid, game: game.name, statId: a.statId, bit: a.bit, name: a.name });
				st.everyMinutes = every;
				st.nextAt = Math.min(st.nextAt && st.nextAt > Date.now() ? st.nextAt : Infinity, Date.now() + every * 60_000);
				ctx.saveState();
				ctx.log(`🏆 ${game.name}: ${add.length} achievement${add.length === 1 ? '' : 's'} will unlock one every ${every} min.`);
				scheduleQueue();
				return view(game);
			},
			'POST clear-queue'() {
				st.queue = [];
				ctx.saveState();
				scheduleQueue();
				ctx.log('🏆 Cleared the achievement unlock queue.');
			},
		},
		on: {
			loggedOn: scheduleQueue,
			stop() { clearTimeout(queueTimer); queueTimer = null; lastGame = null; },
		},
	};
}

module.exports = { create, loadAchievements };
