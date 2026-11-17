'use strict';

// Tool: Badges & boosters.
// Reads your Badges pages (steamcommunity.com, with the login's web session) for every game badge:
// level, cards collected of the set, drops left. Notifies when a badge can be crafted (full set),
// once per badge level. Also reads the Booster Pack Creator page to list boosters you can make now.
// Read-only: it never crafts, buys or spends gems.

const { webRequest } = require('../../lib/web');

const CHECK_MS = 6 * 3_600_000;
const decode = (s) => String(s)
	.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
	.replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/\s+/g, ' ').trim();

// one badges page -> { badges: [...], pages }
function parseBadges(html) {
	const badges = [];
	for (const chunk of html.split(/<div class="badge_row[ "]/).slice(1)) {
		const appid = +(chunk.match(/\/gamecards\/(\d+)/)?.[1] || 0);
		if (!appid) continue;
		const foil = /\/gamecards\/\d+\/?\?border=1/.test(chunk);
		const title = decode((chunk.match(/class="badge_title"[^>]*>([\s\S]*?)<(?:span|div)/)?.[1] || `App ${appid}`));
		const cards = chunk.match(/(\d+)\s+of\s+(\d+)\s+cards?\s+collected/i);
		const drops = +(chunk.match(/(\d+)\s+card drops?\s+remaining/i)?.[1] || 0);
		const level = +(chunk.match(/Level\s+(\d+)/i)?.[1] || 0);
		const craftable = /badge_craft_button|Ready\s*<\/div>/i.test(chunk) || (cards && +cards[1] >= +cards[2] && +cards[2] > 0);
		badges.push({ appid, name: title.replace(/\s*View details\s*$/i, ''), foil, level, owned: cards ? +cards[1] : null, total: cards ? +cards[2] : null, drops, craftable: !!craftable });
	}
	const pages = Math.max(1, ...[...html.matchAll(/class="pagelink"[^>]*>\s*(\d+)\s*</g)].map((m) => +m[1]));
	return { badges, pages };
}

// Booster Pack Creator: CBoosterCreatorPage.Init( [ {appid, name, price, unavailable, available_at_time}, ... ], ...
function parseBoosters(html) {
	const m = html.match(/CBoosterCreatorPage\.Init\(\s*(\[[\s\S]*?\])\s*,/);
	if (!m) return null;
	try {
		return JSON.parse(m[1]).map((b) => ({ appid: +b.appid, name: b.name, gems: +b.price, available: !b.unavailable, availableAt: b.available_at_time || null }));
	} catch { return null; }
}

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.announced ??= {};    // "appid:level" craftable badges already announced
	let badges = [];
	let boosters = null;
	let busy = false;
	let error = null;
	let timer = null;

	async function check(manual = false) {
		if (busy || !ctx.isLoggedIn()) return;
		busy = true;
		try {
			const web = ctx.web();
			const all = [];
			const base = `https://steamcommunity.com/profiles/${ctx.steamID64()}/badges/?l=english`;
			const first = parseBadges(await webRequest(web, `${base}&p=1`, { json: false }));
			all.push(...first.badges);
			for (let p = 2; p <= Math.min(first.pages, 50); p++) {
				all.push(...parseBadges(await webRequest(web, `${base}&p=${p}`, { json: false })).badges);
				await new Promise((r) => setTimeout(r, 1000));
			}
			badges = all;
			if (cfg.boosters) {
				try { boosters = parseBoosters(await webRequest(web, 'https://steamcommunity.com/tradingcards/boostercreator/?l=english', { json: false })); }
				catch (err) { ctx.debug(`booster creator: ${err.message}`); }
			}
			// announce badges that just became craftable
			const fresh = badges.filter((b) => b.craftable && !st.announced[`${b.appid}:${b.foil ? 'f' : ''}${b.level}`]);
			for (const b of fresh) st.announced[`${b.appid}:${b.foil ? 'f' : ''}${b.level}`] = Date.now();
			st.lastCheckAt = Date.now();
			ctx.saveState();
			error = null;
			if (fresh.length && cfg.notifyCraft) {
				ctx.log(`🃏 Ready to craft: ${fresh.slice(0, 4).map((b) => `${b.name}${b.foil ? ' (foil)' : ''}`).join(', ')}${fresh.length > 4 ? ` and ${fresh.length - 4} more` : ''}. Craft them on your Badges page.`, true);
			} else if (manual) {
				ctx.log(`🃏 Badges checked: ${badges.length} game badges, ${badges.filter((b) => b.craftable).length} ready to craft.`);
			}
		} catch (err) {
			error = err.message;
			ctx.debug(`check failed: ${err.stack || err.message}`);
			if (/sign in again/.test(err.message)) ctx.client.webLogOn?.();
		} finally {
			busy = false;
			clearTimeout(timer);
			timer = setTimeout(() => check(), CHECK_MS);
		}
	}

	return {
		snapshot: () => ({
			busy, error, lastCheckAt: st.lastCheckAt || null,
			count: badges.length,
			craftable: badges.filter((b) => b.craftable).length,
			dropsLeft: badges.reduce((a, b) => a + b.drops, 0),
			boostersAvailable: boosters ? boosters.filter((b) => b.available).length : null,
		}),
		routes: {
			'GET data': () => ({
				badges: [...badges].sort((a, b) => b.craftable - a.craftable || ((b.owned ?? 0) / (b.total || 1)) - ((a.owned ?? 0) / (a.total || 1)) || a.name.localeCompare(b.name)),
				boosters: boosters ? [...boosters].sort((a, b) => b.available - a.available || a.gems - b.gems) : null,
			}),
			'POST settings'(body) {
				for (const k of ['notifyCraft', 'boosters']) if (k in body) cfg[k] = !!body[k];
				ctx.saveConfig();
			},
			async 'POST check'() { await check(true); if (error) throw new Error(error); },
		},
		on: {
			loggedOn() { clearTimeout(timer); timer = setTimeout(() => check(), 90_000); },   // after the idler's own card check
			stop() { clearTimeout(timer); timer = null; badges = []; boosters = null; },
		},
	};
}

module.exports = { create, parseBadges, parseBoosters };
