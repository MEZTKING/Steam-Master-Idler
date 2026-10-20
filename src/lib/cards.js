'use strict';

// Reads your Steam badges pages to find which games still have trading-card drops.
// Uses the web-session cookies steam-user gets automatically after login.

const decode = (s) => s
	.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
	.replace(/&quot;/g, '"').replace(/&reg;/g, '®').replace(/&trade;/g, '™').replace(/&copy;/g, '©').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
	.trim();

// Parse one badges page -> { games: [{appid, name, dropsLeft}], pages }
function parseBadgesPage(html) {
	if (/g_steamID\s*=\s*false/.test(html) || /<form[^>]+login/i.test(html) && !html.includes('badge_row')) {
		throw new Error('Not logged in to steamcommunity.com');
	}
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

async function fetchPage(steamID64, cookies, page) {
	let url = `https://steamcommunity.com/profiles/${steamID64}/badges/?l=english&p=${page}`;
	// Follow redirects ourselves so the cookies go along: profiles with a custom URL redirect
	// /profiles/<id>/badges -> /id/<name>/badges. Only a redirect to the login page means logged out.
	for (let hop = 0; hop < 5; hop++) {
		const res = await fetch(url, {
			headers: { Cookie: cookies.join('; '), 'User-Agent': 'Mozilla/5.0 steam-master-idler' },
			redirect: 'manual',
		});
		if (res.status >= 300 && res.status < 400) {
			const next = new URL(res.headers.get('location') || '', url);
			if (next.hostname !== 'steamcommunity.com' || /\/login/i.test(next.pathname)) {
				throw new Error('Not logged in to steamcommunity.com');
			}
			if (!next.searchParams.has('p')) { next.searchParams.set('l', 'english'); next.searchParams.set('p', page); }
			url = next.toString();
			continue;
		}
		if (!res.ok) throw new Error(`steamcommunity.com returned HTTP ${res.status}`);
		return parseBadgesPage(await res.text());
	}
	throw new Error('steamcommunity.com redirected too many times');
}

// Returns a Map appid -> {appid, name, dropsLeft} for every game badge (dropsLeft may be 0).
async function fetchCardDrops(steamID64, cookies) {
	if (!cookies?.length) throw new Error('No web session yet - try again in a few seconds');
	const first = await fetchPage(steamID64, cookies, 1);
	const all = [...first.games];
	for (let p = 2; p <= Math.min(first.pages, 50); p++) {
		all.push(...(await fetchPage(steamID64, cookies, p)).games);
	}
	return new Map(all.map((g) => [g.appid, g]));
}

module.exports = { fetchCardDrops, parseBadgesPage };
