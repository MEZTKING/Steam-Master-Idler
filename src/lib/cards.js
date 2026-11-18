'use strict';

// Reads your Steam badges pages to find which games still have trading-card drops.
// Uses the web-session cookies steam-user gets automatically after login.

const decode = (s) => s
	.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
	.replace(/&quot;/g, '"').replace(/&reg;/g, '®').replace(/&trade;/g, '™').replace(/&copy;/g, '©').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
	.trim();

// Who steamcommunity.com thinks is viewing the page: 'match' (us), 'loggedOut', 'other' or 'unknown'.
function pageLogin(html, steamID64) {
	const m = html.match(/g_steamID\s*=\s*(false|"(\d+)")/);
	if (!m) return 'unknown';
	if (m[1] === 'false') return 'loggedOut';
	return !steamID64 || m[2] === steamID64 ? 'match' : 'other';
}

// Parse one badges page -> { games: [{appid, name, dropsLeft}], pages }
function parseBadgesPage(html, steamID64) {
	const login = pageLogin(html, steamID64);
	if (login === 'loggedOut') throw new Error('Not logged in to steamcommunity.com (Steam rejected the web session)');
	if (login === 'other') throw new Error('steamcommunity.com is logged in as a different account');
	const games = [];
	for (const chunk of html.split(/<div class="badge_row[ "]/).slice(1)) {
		const appid = chunk.match(/\/gamecards\/(\d+)/)?.[1];
		if (!appid) continue;  // not a game badge (events, community badges, ...)
		const progress = chunk.match(/class="progress_info_bold"[^>]*>([^<]*)</)?.[1] || '';
		const n = progress.match(/(\d+)\s+card drops?\s+remaining/i);
		const dropsLeft = n ? parseInt(n[1], 10) : 0;
		const name = decode(chunk.match(/class="badge_title"[^>]*>([^<]*)/)?.[1] || `App ${appid}`);
		games.push({ appid: parseInt(appid, 10), name, dropsLeft });
	}
	const pages = Math.max(1, ...[...html.matchAll(/class="pagelink"[^>]*>\s*(\d+)\s*</g)].map((m) => parseInt(m[1], 10)));
	return { games, pages };
}

// trace: filled with one entry per HTTP request, for the diagnostics report (no cookies in it)
async function fetchPage(steamID64, cookies, page, trace) {
	let url = `https://steamcommunity.com/profiles/${steamID64}/badges/?l=english&p=${page}`;
	// Follow redirects ourselves so the cookies go along: profiles with a custom URL redirect
	// /profiles/<id>/badges -> /id/<name>/badges. Only a redirect to the login page means logged out.
	for (let hop = 0; hop < 5; hop++) {
		const entry = { url: url.replace(/^https:\/\/steamcommunity\.com/, '') };
		trace.push(entry);
		const res = await fetch(url, {
			headers: { Cookie: cookies.join('; '), 'User-Agent': 'Mozilla/5.0 steam-master-idler' },
			redirect: 'manual',
		});
		entry.status = res.status;
		if (res.status >= 300 && res.status < 400) {
			const next = new URL(res.headers.get('location') || '', url);
			entry.redirect = next.hostname === 'steamcommunity.com' ? next.pathname : next.hostname + next.pathname;
			if (next.hostname !== 'steamcommunity.com' || /\/login/i.test(next.pathname)) {
				throw new Error('Not logged in to steamcommunity.com (redirected to the login page)');
			}
			if (!next.searchParams.has('p')) { next.searchParams.set('l', 'english'); next.searchParams.set('p', page); }
			url = next.toString();
			continue;
		}
		if (!res.ok) throw new Error(`steamcommunity.com returned HTTP ${res.status}`);
		const html = await res.text();
		entry.bytes = html.length;
		entry.login = pageLogin(html, steamID64);
		entry.badgeRows = (html.match(/<div class="badge_row[ "]/g) || []).length;
		// nothing recognised on a full-sized page: Steam probably changed the page. Record how the
		// page is built (class names, link shapes, embedded data), never its text, so it can be fixed.
		if (!entry.badgeRows && html.length > 50_000) entry.shape = pageShape(html);
		return parseBadgesPage(html, steamID64);
	}
	throw new Error('steamcommunity.com redirected too many times');
}

function pageShape(html) {
	const count = (re) => (html.match(re) || []).length;
	const classes = {};
	for (const m of html.matchAll(/class="([^"]+)"/g)) {
		for (const c of m[1].split(/\s+/)) if (/badge|card|drop|progress/i.test(c)) classes[c] = (classes[c] || 0) + 1;
	}
	return {
		classes: Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 40),
		gamecardLinks: count(/\/gamecards\/\d+/g),
		dropsText: count(/card drops? remaining/gi),
		collectedText: count(/cards? collected/gi),
		dataAttrs: [...new Set([...html.matchAll(/\s(data-[\w-]+)=/g)].map((m) => m[1]))].slice(0, 40),
		jsonVars: [...new Set([...html.matchAll(/(?:window\.|var |const |let )([A-Za-z_$][\w$]*)\s*=\s*[{[]/g)].map((m) => m[1]))].slice(0, 30),
		reactRoots: count(/data-react|__NEXT_DATA__|SSR|application\/json/g),
	};
}

// Returns a Map appid -> {appid, name, dropsLeft} for every game badge (dropsLeft may be 0).
// On failure the error has a .trace of the requests made.
async function fetchCardDrops(steamID64, cookies) {
	const trace = [];
	try {
		if (!cookies?.length) throw new Error('No web session yet - try again in a few seconds');
		const first = await fetchPage(steamID64, cookies, 1, trace);
		const all = [...first.games];
		for (let p = 2; p <= Math.min(first.pages, 50); p++) {
			all.push(...(await fetchPage(steamID64, cookies, p, trace)).games);
		}
		const drops = new Map(all.map((g) => [g.appid, g]));
		drops.trace = trace;
		return drops;
	} catch (err) {
		err.trace = trace;
		throw err;
	}
}

module.exports = { fetchCardDrops, parseBadgesPage };
