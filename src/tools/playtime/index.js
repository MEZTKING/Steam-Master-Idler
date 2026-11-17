'use strict';

// Tool: Playtime reports.
// Every few hours it compares your library's playtime with the last check and books the difference
// on that day, so it builds a day-by-day history (kept 120 days; Steam's playtime, so idled hours
// count too). A weekly summary arrives as a notification on Monday. Also suggests games from your
// library you've never started or haven't touched in a long time.

const SYNC_MS = 4 * 3_600_000;
const KEEP_DAYS = 120;
const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hrs = (min) => `${(min / 60).toFixed(1)} h`;

// the coming Monday 10:00 (local time) after t
function nextMonday(t = Date.now()) {
	const d = new Date(t);
	d.setHours(10, 0, 0, 0);
	const add = (8 - d.getDay()) % 7 || (d.getTime() > t ? 0 : 7);
	d.setDate(d.getDate() + add);
	return d.getTime();
}

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.days ??= {};       // "YYYY-MM-DD" -> { appid: minutes played that day }
	st.last ??= null;     // appid -> minutes at the last sync
	st.reports ??= [];
	let timer = null;

	// the minutes each game gained since the last sync go on today's page
	function sync() {
		const lib = ctx.library();
		if (!lib.length) return;
		const now = Object.fromEntries(lib.map((g) => [g.appid, g.minutes]));
		if (st.last) {
			const today = (st.days[dayKey()] ??= {});
			for (const [id, min] of Object.entries(now)) {
				const d = min - (st.last[id] ?? min);
				if (d > 0) today[id] = (today[id] || 0) + d;
			}
		}
		st.last = now;
		st.lastSyncAt = Date.now();
		const cutoff = dayKey(Date.now() - KEEP_DAYS * 86_400_000);
		for (const k of Object.keys(st.days)) if (k < cutoff) delete st.days[k];
		ctx.saveState();
	}

	function range(days) {
		const from = dayKey(Date.now() - (days - 1) * 86_400_000);
		const per = {};
		const series = [];
		for (let i = days - 1; i >= 0; i--) {
			const k = dayKey(Date.now() - i * 86_400_000);
			const day = st.days[k] || {};
			series.push({ day: k, minutes: Object.values(day).reduce((a, b) => a + b, 0) });
			if (k >= from) for (const [id, m] of Object.entries(day)) per[id] = (per[id] || 0) + m;
		}
		const games = Object.entries(per).map(([id, minutes]) => ({ appid: +id, name: ctx.gameName(+id), minutes })).sort((a, b) => b.minutes - a.minutes);
		return { series, games, total: games.reduce((a, g) => a + g.minutes, 0) };
	}

	function weeklyReport() {
		const r = range(7);
		const report = { at: Date.now(), total: r.total, games: r.games.slice(0, 5) };
		st.reports.unshift(report);
		st.reports.length = Math.min(st.reports.length, 12);
		st.nextReportAt = nextMonday();
		ctx.saveState();
		if (cfg.weekly) {
			ctx.log(r.total
				? `📊 Your week on Steam: ${hrs(r.total)} across ${r.games.length} game${r.games.length === 1 ? '' : 's'}. Most: ${r.games.slice(0, 3).map((g) => `${g.name} (${hrs(g.minutes)})`).join(', ')}.`
				: '📊 Your week on Steam: nothing played or idled.', true);
		}
	}

	async function tick() {
		try {
			if (ctx.isLoggedIn()) { await ctx.refreshLibrary().catch(() => {}); sync(); }
			st.nextReportAt ??= nextMonday();
			if (Date.now() >= st.nextReportAt && st.last) weeklyReport();
		} finally {
			clearTimeout(timer);
			timer = setTimeout(tick, SYNC_MS);
		}
	}

	return {
		snapshot: () => {
			const w = range(7);
			return { lastSyncAt: st.lastSyncAt || null, since: Object.keys(st.days).sort()[0] || null, week: w.total, today: range(1).total, top: w.games.slice(0, 3), nextReportAt: st.nextReportAt || null };
		},
		routes: {
			'GET data'(q) {
				const days = [7, 30, 90].includes(+q.days) ? +q.days : 30;
				const r = range(days);
				const lib = ctx.library();
				const never = lib.filter((g) => !g.minutes);
				const yearAgo = Date.now() - 365 * 86_400_000;
				const forgotten = lib.filter((g) => g.minutes > 0 && g.lastPlayed && g.lastPlayed < yearAgo).sort((a, b) => a.lastPlayed - b.lastPlayed);
				// a few picks to try, different every day
				const seed = Number(dayKey().replace(/-/g, ''));
				const pick = (arr, n) => arr.map((g, i) => [((g.appid * 2654435761 + seed) >>> 0) % 1000003, g]).sort((a, b) => a[0] - b[0]).slice(0, n).map(([, g]) => g);
				return {
					days, ...r,
					reports: st.reports.slice(0, 6),
					never: { count: never.length, picks: pick(never, 6).map((g) => ({ appid: g.appid, name: g.name })) },
					forgotten: { count: forgotten.length, picks: pick(forgotten, 6).map((g) => ({ appid: g.appid, name: g.name, minutes: g.minutes, lastPlayed: g.lastPlayed })) },
				};
			},
			'POST settings'(body) { if ('weekly' in body) cfg.weekly = !!body.weekly; ctx.saveConfig(); },
			'POST report-now'() { sync(); weeklyReport(); },
		},
		on: {
			loggedOn() { clearTimeout(timer); timer = setTimeout(tick, 60_000); },
			stop() { clearTimeout(timer); timer = null; },
		},
	};
}

module.exports = { create, nextMonday };
