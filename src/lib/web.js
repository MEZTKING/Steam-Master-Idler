'use strict';

// Requests to Steam websites with the web session steam-user gets at login.

// steam-user's cookies look like "name=value; Path=/; Secure; Domain=store.steampowered.com";
// pick the ones meant for host (or for no particular site)
function cookieHeader(cookies, host) {
	const out = new Map();
	for (const c of cookies || []) {
		const [pair, ...attrs] = c.split(';').map((x) => x.trim());
		const domain = attrs.find((a) => /^domain=/i.test(a))?.slice(7).replace(/^\./, '');
		if (domain && domain !== host && !host.endsWith(`.${domain}`)) continue;
		const name = pair.split('=')[0];
		if (!out.has(name) || domain) out.set(name, pair);
	}
	return [...out.values()].join('; ');
}

async function webRequest(web, url, { method = 'GET', form = null, json = true } = {}) {
	if (!web) throw new Error('No Steam web session yet. Try again in a minute.');
	const host = new URL(url).hostname;
	const headers = { Cookie: cookieHeader(web.cookies, host), 'User-Agent': 'Mozilla/5.0 steam-master-idler' };
	let body;
	if (form) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
		body = new URLSearchParams({ ...form }).toString();
	}
	const res = await fetch(url, { method, headers, body, redirect: 'manual' });
	if (res.status >= 300 && res.status < 400) throw new Error('Steam asked to sign in again (web session expired).');
	const text = await res.text();
	if (!res.ok) throw new Error(`${host} answered HTTP ${res.status}`);
	if (!json) return text;
	try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = { cookieHeader, webRequest };
