'use strict';

// Tool: Market value (read-only).
// Reads your Steam community inventory (app 753: trading cards, foils, backgrounds, emoticons,
// booster packs, gems) and the lowest Steam Market price of each kind of item, then shows what it's
// worth. Prices are looked up slowly (Steam limits this) and kept for a day. Never lists or sells.

const SteamUser = require('steam-user');
const { webRequest } = require('../../lib/web');

const PRICE_TTL = 24 * 3_600_000;
const PRICE_GAP = 3500;                 // ms between price lookups (Steam allows ~20/min)
const REFRESH_MS = 24 * 3_600_000;

// "1.234,56€" | "$1,234.56" | "1 234,56 pуб." | "¥ 1,234" -> cents
function priceCents(text) {
	const s = String(text || '').replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
	if (!s) return null;
	const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
	if (lastSep >= 0 && s.length - lastSep - 1 === 2) return parseInt(s.slice(0, lastSep).replace(/[.,]/g, '') + s.slice(lastSep + 1), 10);
	return parseInt(s.replace(/[.,]/g, ''), 10) * 100;
}

function kindOf(type) {
	const t = String(type || '');
	if (/foil trading card/i.test(t)) return 'Foil card';
	if (/trading card/i.test(t)) return 'Trading card';
	if (/profile background/i.test(t)) return 'Background';
	if (/emoticon/i.test(t)) return 'Emoticon';
	if (/booster pack/i.test(t)) return 'Booster pack';
	if (/gems/i.test(t)) return 'Gems';
	return 'Other';
}

function create(ctx) {
	const st = ctx.state;
	st.prices ??= {};       // market_hash_name -> { cents, text, volume, at }
	let items = [];         // [{ hash, name, kind, game, count, marketable, icon }]
	let busy = false;
	let pricing = null;     // { done, total }
	let error = null;
	let timer = null;
	let stopped = false;

	const currency = () => ctx.client.wallet?.currency || 1;
	const currencyCode = () => SteamUser.ECurrencyCode?.[currency()] || '';
	const fmt = (cents) => {
		if (cents == null) return '—';
		try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode() || 'USD' }).format(cents / 100); }
		catch { return `${(cents / 100).toFixed(2)} ${currencyCode()}`; }
	};

	async function loadInventory() {
		const web = ctx.web();
		const all = new Map();
		let start = null;
		for (let page = 0; page < 20; page++) {
			const url = `https://steamcommunity.com/inventory/${ctx.steamID64()}/753/6?l=english&count=2000${start ? `&start_assetid=${start}` : ''}`;
			const j = await webRequest(web, url);
			if (j.success === false || j.raw) throw new Error("Couldn't read your inventory (is it private, or is Steam busy?)");
			const desc = new Map((j.descriptions || []).map((d) => [`${d.classid}_${d.instanceid}`, d]));
			for (const a of j.assets || []) {
				const d = desc.get(`${a.classid}_${a.instanceid}`);
				if (!d) continue;
				const hash = d.market_hash_name || d.name;
				const it = all.get(hash) || { hash, name: d.name, kind: kindOf(d.type), game: (d.tags || []).find((t) => t.category === 'Game')?.localized_tag_name || '', count: 0, marketable: !!d.marketable, icon: d.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${d.icon_url}/64fx64f` : null };
				it.count += Number(a.amount || 1);
				all.set(hash, it);
			}
			if (!j.more_items) break;
			start = j.last_assetid;
		}
		items = [...all.values()];
	}

	async function lookupPrices() {
		const todo = items.filter((i) => i.marketable && (!st.prices[i.hash] || Date.now() - st.prices[i.hash].at > PRICE_TTL || st.prices[i.hash].currency !== currency()));
		pricing = { done: 0, total: todo.length };
		for (const it of todo) {
			if (stopped || !ctx.isLoggedIn()) break;
			const url = `https://steamcommunity.com/market/priceoverview/?appid=753&currency=${currency()}&market_hash_name=${encodeURIComponent(it.hash)}`;
			const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 kettle' } });
			if (r.status === 429) {   // too many: wait and carry on later
				ctx.debug('market: rate limited, pausing 5 min');
				await new Promise((res) => setTimeout(res, 5 * 60_000));
				continue;
			}
			const j = r.ok ? await r.json().catch(() => null) : null;
			const text = j?.lowest_price || j?.median_price || null;
			st.prices[it.hash] = { cents: priceCents(text), text, volume: j?.volume ? parseInt(String(j.volume).replace(/\D/g, ''), 10) : 0, at: Date.now(), currency: currency() };
			pricing.done++;
			if (pricing.done % 20 === 0) ctx.saveState();
			await new Promise((res) => setTimeout(res, PRICE_GAP));
		}
		ctx.saveState();
		pricing = null;
	}

	async function refresh(manual = false) {
		if (busy || !ctx.isLoggedIn()) return;
		busy = true;
		try {
			await loadInventory();
			error = null;
			st.lastScanAt = Date.now();
			await lookupPrices();
			const t = totals();
			if (manual) ctx.log(`💰 Inventory value: about ${fmt(t.cents)} (${t.priced} of ${t.marketable} kinds of item priced).`);
		} catch (err) {
			error = err.message;
			ctx.debug(`refresh: ${err.stack || err.message}`);
		} finally {
			busy = false;
			pricing = null;
			clearTimeout(timer);
			if (!stopped) timer = setTimeout(() => refresh(), REFRESH_MS);
		}
	}

	function totals() {
		let cents = 0; let priced = 0; let marketable = 0;
		const byKind = {};
		for (const i of items) {
			if (!i.marketable) continue;
			marketable++;
			const p = st.prices[i.hash];
			if (p?.cents == null) continue;
			priced++;
			cents += p.cents * i.count;
			byKind[i.kind] = (byKind[i.kind] || 0) + p.cents * i.count;
		}
		return { cents, priced, marketable, byKind };
	}

	return {
		snapshot: () => {
			const t = totals();
			return { busy, error, pricing, lastScanAt: st.lastScanAt || null, kinds: items.length, total: t.cents, totalText: fmt(t.cents), priced: t.priced, marketable: t.marketable };
		},
		routes: {
			'GET data'() {
				const t = totals();
				return {
					totalText: fmt(t.cents),
					// what you'd get after Steam's fees (~15%)
					afterFeesText: fmt(Math.round(t.cents / 1.15)),
					byKind: Object.entries(t.byKind).map(([kind, cents]) => ({ kind, text: fmt(cents), cents })).sort((a, b) => b.cents - a.cents),
					items: items.map((i) => {
						const p = st.prices[i.hash];
						return { ...i, price: p?.text || null, cents: p?.cents ?? null, value: p?.cents != null ? fmt(p.cents * i.count) : null, valueCents: p?.cents != null ? p.cents * i.count : -1, volume: p?.volume || 0,
							marketUrl: i.marketable ? `https://steamcommunity.com/market/listings/753/${encodeURIComponent(i.hash)}` : null };
					}).sort((a, b) => b.valueCents - a.valueCents || a.name.localeCompare(b.name)),
				};
			},
			async 'POST refresh'() { if (!busy) refresh(true); },
		},
		on: {
			// read the inventory a few minutes after signing in (one request); prices from the last day are reused
			loggedOn() { stopped = false; clearTimeout(timer); timer = setTimeout(() => refresh(), 3 * 60_000); },
			stop() { stopped = true; clearTimeout(timer); timer = null; items = []; },
		},
	};
}

module.exports = { create, priceCents, kindOf };
