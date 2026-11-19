'use strict';

// Tool: Wishlist sale alerts.
// Every few hours: reads your wishlist and the current store prices (both over the Steam client
// connection) and sends a notification for games that are discounted at least X %, or at/below the
// price you set for them. Each deal is announced once.
//
// Optional "may be delisted soon": flags wishlist games that are no longer sold, and once a day reads
// each game's recent Steam news (small JSON, no key) for delisting notices ("will be removed from
// Steam", "last chance to buy", ...). Steam has no official flag for this, so it's a best guess.

const { callService, defineTypes } = require('../../lib/steam-cm');
const { getStoreItems } = require('../../lib/store');

const DELIST_RE = /\b(delist(?:ed|ing)?|de-list(?:ed|ing)?|(?:will be|is being|are being) (?:removed|pulled|taken down) from (?:the )?(?:steam|store)|removed from (?:the )?steam store|no longer (?:be )?(?:available|sold|purchasable|for sale|on sale) (?:on|from|in) (?:the )?(?:steam|store)|(?:removed|pulled) from sale|last chance to (?:buy|purchase|grab|get)|leaving (?:the )?steam(?: store)?|license (?:is )?expir\w*|stop selling)\b/i;
const NEWS_MAX_AGE = 180 * 86_400_000;
const DELIST_EVERY = 24 * 3_600_000;

defineTypes({
	CWishlist_GetWishlist_Request: { fields: { steamid: { type: 'fixed64', id: 1 } } },
	CWishlist_GetWishlist_Response: { fields: { items: { rule: 'repeated', type: 'WishlistItem', id: 1 } } },
	WishlistItem: { fields: { appid: { type: 'uint32', id: 1 }, priority: { type: 'uint32', id: 2 }, date_added: { type: 'uint32', id: 3 } } },
});

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.targets ??= {};      // appid -> price in cents you'd pay
	st.announced ??= {};    // appid -> final cents last announced
	st.delist ??= {};       // appid -> { kind: 'gone'|'news', title, url, date, at }
	st.delistAnnounced ??= {};
	st.freeAnnounced ??= {};   // "appid:kind:until" free weekends / free-to-keep already announced
	let delistTimer = null;
	let delistBusy = false;
	let items = [];         // last check (kept in memory only)
	let timer = null;
	let busy = false;
	let error = null;

	async function fetchWishlist() {
		try {
			const res = await callService(ctx.client, 'Wishlist.GetWishlist#1', 'CWishlist_GetWishlist_Request', 'CWishlist_GetWishlist_Response', { steamid: ctx.steamID64() });
			return res.items.map((i) => ({ appid: i.appid, priority: i.priority, added: i.date_added * 1000 }));
		} catch (err) {
			// public wishlists are also readable from the Web API
			ctx.debug(`wishlist over CM failed (${err.message}), trying the Web API`);
			const r = await fetch(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${ctx.steamID64()}`);
			if (!r.ok) throw new Error(`Couldn't read your wishlist (${err.message})`);
			const j = await r.json();
			return (j.response?.items || []).map((i) => ({ appid: i.appid, priority: i.priority, added: i.date_added * 1000 }));
		}
	}

	const isDeal = (it) => it.finalCents != null && it.finalCents > 0 &&
		(it.discount >= cfg.minDiscount || (st.targets[it.appid] != null && it.finalCents <= st.targets[it.appid]));

	async function check(manual = false) {
		if (busy || !ctx.isLoggedIn()) return;
		busy = true;
		try {
			const wish = await fetchWishlist();
			const prices = await getStoreItems(ctx.client, wish.map((w) => w.appid), { country: ctx.country() });
			items = wish.map((w) => ({ ...w, ...(prices.get(w.appid) || { appid: w.appid, name: `App ${w.appid}` }) }));
			if (cfg.freeAlerts !== false) announceFree();
			const deals = items.filter(isDeal);
			const fresh = deals.filter((d) => st.announced[d.appid] !== d.finalCents);
			for (const id of Object.keys(st.announced)) if (!deals.some((d) => d.appid === +id)) delete st.announced[id];
			for (const d of fresh) st.announced[d.appid] = d.finalCents;
			st.lastCheckAt = Date.now();
			if (cfg.delistWatch) flagGone();
			ctx.saveState();
			error = null;
			if (fresh.length) {
				const top = fresh.sort((a, b) => b.discount - a.discount).slice(0, 3).map((d) => (d.discount ? `${d.name} −${d.discount}% (${d.price})` : `${d.name} at ${d.price} (your price)`)).join(', ');
				ctx.log(`🏷 On sale from your wishlist: ${top}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ''}.`, true);
			} else if (manual) {
				ctx.log(`🏷 Wishlist checked: ${deals.length ? `${deals.length} deal(s), nothing new` : 'no deals right now'}.`);
			}
		} catch (err) {
			error = err.message;
			ctx.debug(`check failed: ${err.stack || err.message}`);
		} finally {
			busy = false;
			schedule();
		}
	}

	// ----- free weekends and free-to-keep -----
	const freeKind = (it) => {
		const fw = it.freeWeekend;
		if (fw && (!fw.end || fw.end > Date.now())) return { kind: 'weekend', until: fw.end || 0, text: fw.text };
		if (it.freeTemporarily) return { kind: 'weekend', until: it.endsAt || 0 };
		if (it.finalCents === 0 && it.originalCents > 0) return { kind: 'keep', until: it.endsAt || 0 };
		return null;
	};
	function announceFree() {
		const weekend = [];
		const keep = [];
		for (const it of items) {
			const f = freeKind(it);
			if (!f) continue;
			const key = `${it.appid}:${f.kind}:${f.until}`;
			if (st.freeAnnounced[key]) continue;
			st.freeAnnounced[key] = Date.now();
			(f.kind === 'keep' ? keep : weekend).push(`${it.name}${f.until ? ` (until ${new Date(f.until).toLocaleDateString()})` : ''}`);
		}
		for (const [k, t] of Object.entries(st.freeAnnounced)) if (Date.now() - t > 30 * 86_400_000) delete st.freeAnnounced[k];
		if (keep.length) ctx.log(`🆓 Free to keep from your wishlist: ${keep.join(', ')}. Claim it on the store page, or with the Free game claimer.`, true);
		if (weekend.length) ctx.log(`🎮 Free to play now from your wishlist: ${weekend.join(', ')}.`, true);
	}

	// ----- may be delisted soon -----
	// hidden from the store or unlisted (games that aren't out yet have no price but are still listed)
	const gone = (it) => it.visible === false || it.unlisted === true;
	function flagGone() {
		for (const it of items) {
			const cur = st.delist[it.appid];
			if (gone(it)) {
				if (cur?.kind !== 'gone') st.delist[it.appid] = { kind: 'gone', title: 'No longer for sale on Steam', at: Date.now() };
			} else if (cur?.kind === 'gone') {
				delete st.delist[it.appid];   // back on sale
			}
		}
		announceDelist();
	}

	function announceDelist() {
		const fresh = Object.entries(st.delist).filter(([id, d]) => !st.delistAnnounced[id] && items.some((i) => i.appid === +id))
			.map(([id, d]) => ({ id: +id, d, name: items.find((i) => i.appid === +id)?.name || `App ${id}` }));
		for (const f of fresh) st.delistAnnounced[f.id] = Date.now();
		for (const id of Object.keys(st.delistAnnounced)) if (!st.delist[id]) delete st.delistAnnounced[id];
		if (!fresh.length) return;
		const leaving = fresh.filter((f) => f.d.kind === 'news');
		const goneNow = fresh.filter((f) => f.d.kind === 'gone');
		if (leaving.length) ctx.log(`⚠ May be delisted soon (from your wishlist): ${leaving.map((f) => f.name).join(', ')}. Buy before it's gone?`, true);
		if (goneNow.length) ctx.log(`⚠ No longer sold on Steam (from your wishlist): ${goneNow.map((f) => f.name).join(', ')}.`, true);
		ctx.saveState();
	}

	async function newsCheck(appid) {
		const r = await fetch(`https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appid}&count=8&maxlength=800&format=json`,
			{ headers: { 'User-Agent': 'kettle' } });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const news = (await r.json()).appnews?.newsitems || [];
		for (const n of news) {
			if (Date.now() - n.date * 1000 > NEWS_MAX_AGE) continue;
			const text = `${n.title || ''} ${String(n.contents || '').replace(/<[^>]+>|\[[^\]]+\]/g, ' ')}`;
			if (DELIST_RE.test(text)) return { kind: 'news', title: n.title, url: n.url, date: n.date * 1000, at: Date.now() };
		}
		return null;
	}

	async function delistScan() {
		if (delistBusy || !cfg.delistWatch || !ctx.isLoggedIn() || !items.length) return;
		delistBusy = true;
		try {
			for (const it of items) {
				if (!cfg.delistWatch) break;
				if (st.delist[it.appid]?.kind === 'gone') continue;
				try {
					const hit = await newsCheck(it.appid);
					if (hit) st.delist[it.appid] = hit;
					else if (st.delist[it.appid]?.kind === 'news') delete st.delist[it.appid];
				} catch (err) {
					ctx.debug(`news ${it.appid}: ${err.message}`);
				}
				await new Promise((r) => setTimeout(r, 1500));   // gentle on Steam's API
			}
			st.delistCheckedAt = Date.now();
			announceDelist();
			ctx.saveState();
		} finally {
			delistBusy = false;
			scheduleDelist();
		}
	}

	function scheduleDelist() {
		clearTimeout(delistTimer);
		delistTimer = null;
		if (!cfg.delistWatch) return;
		const wait = Math.max(5 * 60_000, (st.delistCheckedAt || 0) + DELIST_EVERY - Date.now());
		delistTimer = setTimeout(delistScan, wait);
	}

	function schedule() {
		clearTimeout(timer);
		const every = cfg.everyHours * 3_600_000;
		const due = (st.lastCheckAt || 0) + every;
		timer = setTimeout(() => check(), Math.max(60_000, due - Date.now()));
	}

	const nextAt = () => (st.lastCheckAt ? st.lastCheckAt + cfg.everyHours * 3_600_000 : null);

	return {
		snapshot: () => ({
			busy, error, lastCheckAt: st.lastCheckAt || null, nextAt: nextAt(),
			count: items.length, deals: items.filter(isDeal).length, onSale: items.filter((i) => i.discount > 0).length,
			delist: cfg.delistWatch ? {
				scanning: delistBusy, checkedAt: st.delistCheckedAt || null,
				flagged: items.filter((i) => st.delist[i.appid]).length,
			} : null,
		}),
		routes: {
			'GET data'() {
				return {
					items: items.map((i) => ({ appid: i.appid, name: i.name, price: i.price, originalPrice: i.originalPrice, discount: i.discount,
						finalCents: i.finalCents, endsAt: i.endsAt, deal: isDeal(i), target: st.targets[i.appid] ?? null,
						delist: cfg.delistWatch ? st.delist[i.appid] || null : null, free: freeKind(i)?.kind || (i.free ? 'f2p' : null) }))
						.sort((a, b) => !!b.delist - !!a.delist || b.deal - a.deal || b.discount - a.discount || a.name.localeCompare(b.name)),
				};
			},
			'POST settings'(body) {
				if ('minDiscount' in body) cfg.minDiscount = Math.max(1, Math.min(100, parseInt(body.minDiscount, 10) || 50));
				if ('freeAlerts' in body) cfg.freeAlerts = !!body.freeAlerts;
				if ('everyHours' in body) cfg.everyHours = [1, 3, 6, 12, 24].includes(+body.everyHours) ? +body.everyHours : 6;
				if ('delistWatch' in body) {
					cfg.delistWatch = !!body.delistWatch;
					if (cfg.delistWatch) { flagGone(); st.delistCheckedAt = 0; }
				}
				ctx.saveConfig();
				schedule();
				scheduleDelist();
			},
			// { appid, price } price in your currency's units ("" clears it)
			'POST target'(body) {
				const appid = parseInt(body.appid, 10);
				const p = parseFloat(String(body.price).replace(',', '.'));
				if (!appid) throw new Error('Bad game');
				if (!(p > 0)) delete st.targets[appid]; else st.targets[appid] = Math.round(p * 100);
				ctx.saveState();
			},
			async 'POST check'() { await check(true); if (error) throw new Error(error); },
		},
		on: {
			// check soon after signing in (deals already announced aren't announced again)
			loggedOn() { clearTimeout(timer); timer = setTimeout(() => check().then(scheduleDelist), 30_000); },
			stop() { clearTimeout(timer); clearTimeout(delistTimer); timer = delistTimer = null; items = []; },
		},
	};
}

module.exports = { create };
