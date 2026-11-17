'use strict';

// Tool: Wishlist sale alerts.
// Every few hours: reads your wishlist and the current store prices (both over the Steam client
// connection) and sends a notification for games that are discounted at least X %, or at/below the
// price you set for them. Each deal is announced once.

const { callService, defineTypes } = require('../../lib/steam-cm');
const { getStoreItems } = require('../../lib/store');

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
			const deals = items.filter(isDeal);
			const fresh = deals.filter((d) => st.announced[d.appid] !== d.finalCents);
			for (const id of Object.keys(st.announced)) if (!deals.some((d) => d.appid === +id)) delete st.announced[id];
			for (const d of fresh) st.announced[d.appid] = d.finalCents;
			st.lastCheckAt = Date.now();
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
		}),
		routes: {
			'GET data'() {
				return {
					items: items.map((i) => ({ appid: i.appid, name: i.name, price: i.price, originalPrice: i.originalPrice, discount: i.discount,
						finalCents: i.finalCents, endsAt: i.endsAt, free: i.free, deal: isDeal(i), target: st.targets[i.appid] ?? null }))
						.sort((a, b) => b.deal - a.deal || b.discount - a.discount || a.name.localeCompare(b.name)),
				};
			},
			'POST settings'(body) {
				if ('minDiscount' in body) cfg.minDiscount = Math.max(1, Math.min(100, parseInt(body.minDiscount, 10) || 50));
				if ('everyHours' in body) cfg.everyHours = [1, 3, 6, 12, 24].includes(+body.everyHours) ? +body.everyHours : 6;
				ctx.saveConfig();
				schedule();
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
			loggedOn() { clearTimeout(timer); timer = setTimeout(() => check(), 30_000); },
			stop() { clearTimeout(timer); timer = null; items = []; },
		},
	};
}

module.exports = { create };
