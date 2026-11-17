'use strict';

// Steam store data over the client connection (no web requests, no rate-limited store API).

const { callService } = require('./steam-cm');

const cents = (v) => (v == null ? null : Number(v));

// Name + current price of up to any number of apps: Map appid -> item
async function getStoreItems(client, appids, { country = 'US', allOptions = false } = {}) {
	const out = new Map();
	for (let i = 0; i < appids.length; i += 100) {
		const res = await callService(client, 'StoreBrowse.GetItems#1', 'CStoreBrowse_GetItems_Request', 'CStoreBrowse_GetItems_Response', {
			ids: appids.slice(i, i + 100).map((appid) => ({ appid })),
			context: { language: 'english', country_code: country || 'US' },
			data_request: { include_all_purchase_options: allOptions },
		});
		for (const it of res.store_items || []) {
			const best = it.best_purchase_option;
			const discount = best?.active_discounts?.[0];
			out.set(it.appid || it.id, {
				appid: it.appid || it.id,
				name: it.name || `App ${it.appid || it.id}`,
				visible: it.success === 1 && it.visible !== false,
				free: !!it.is_free,
				freeTemporarily: !!it.is_free_temporarily,
				price: best ? best.formatted_final_price || null : null,
				originalPrice: best ? best.formatted_original_price || null : null,
				finalCents: best ? cents(best.final_price_in_cents) : null,
				originalCents: best ? cents(best.original_price_in_cents) : null,
				discount: best ? best.discount_pct || 0 : 0,
				endsAt: discount?.discount_end_date ? discount.discount_end_date * 1000 : null,
				options: allOptions ? (it.purchase_options || []).map((o) => ({
					packageid: o.packageid || null, bundleid: o.bundleid || null, name: o.purchase_option_name,
					finalCents: cents(o.final_price_in_cents), canPurchase: o.user_can_purchase,
				})) : undefined,
			});
		}
	}
	return out;
}

module.exports = { getStoreItems };
