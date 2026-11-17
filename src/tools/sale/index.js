'use strict';

// Tool: Sale event helper.
// Once per Steam day (the store's day starts 10:00 Pacific): claims the free daily sale sticker
// (SaleItemRewards) and goes through your Discovery Queue, which during sales gives event rewards.
// Outside a sale the sticker simply isn't there and nothing else happens.

const { callService, defineTypes } = require('../../lib/steam-cm');

defineTypes({
	CSaleItemRewards_CanClaimItem_Request: { fields: { language: { type: 'string', id: 1 } } },
	CSaleItemRewards_CanClaimItem_Response: { fields: { can_claim: { type: 'bool', id: 1 }, next_claim_time: { type: 'uint32', id: 2 } } },
	CSaleItemRewards_ClaimItem_Request: { fields: { language: { type: 'string', id: 1 } } },
	CSaleItemRewards_ClaimItem_Response: { fields: { communityitemid: { type: 'uint64', id: 1 }, next_claim_time: { type: 'uint32', id: 2 } } },
});

const CHECK_MS = 3 * 3_600_000;
// Steam's store day flips at 10:00 Pacific = 17:00 UTC in summer, 18:00 in winter; 18:00 is safe all year
const steamDay = (t = Date.now()) => Math.floor((t - 18 * 3_600_000) / 86_400_000);
const nextDayStart = () => (steamDay() + 1) * 86_400_000 + 18 * 3_600_000;

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.results ??= [];   // recent: [{ at, what, ok, text }]
	let timer = null;
	let busy = false;

	function note(what, ok, text) {
		st.results.unshift({ at: Date.now(), what, ok, text });
		st.results.length = Math.min(st.results.length, 12);
		ctx.saveState();
	}

	async function sticker(force) {
		if (!force && st.stickerDay === steamDay()) return;
		const can = await callService(ctx.client, 'SaleItemRewards.CanClaimItem#1', 'CSaleItemRewards_CanClaimItem_Request', 'CSaleItemRewards_CanClaimItem_Response', { language: 'english' });
		st.stickerDay = steamDay();
		if (!can.can_claim) {
			note('sticker', true, can.next_claim_time ? 'Already claimed today.' : 'No free sale item right now.');
			return;
		}
		await callService(ctx.client, 'SaleItemRewards.ClaimItem#1', 'CSaleItemRewards_ClaimItem_Request', 'CSaleItemRewards_ClaimItem_Response', { language: 'english' });
		note('sticker', true, 'Claimed the free daily sale item.');
		ctx.log("🎁 Claimed today's free Steam sale item.", true);
	}

	async function discovery(force) {
		if (!force && st.queueDay === steamDay()) return;
		let seen = 0;
		for (let q = 0; q < cfg.queues; q++) {
			const res = await callService(ctx.client, 'Store.GetDiscoveryQueue#1', 'CStore_GetDiscoveryQueue_Request', 'CStore_GetDiscoveryQueue_Response',
				{ queue_type: 0, country_code: ctx.country() || 'US', rebuild_queue: q > 0 });
			for (const appid of res.appids || []) {
				await callService(ctx.client, 'Store.SkipDiscoveryQueueItem#1', 'CStore_SkipDiscoveryQueueItem_Request', 'CStore_SkipDiscoveryQueueItem_Response', { queue_type: 0, appid });
				seen++;
				await new Promise((r) => setTimeout(r, 300));
			}
		}
		st.queueDay = steamDay();
		note('queue', true, `Went through ${cfg.queues} Discovery Queue${cfg.queues === 1 ? '' : 's'} (${seen} games).`);
		ctx.log(`🎁 Went through your Discovery Queue (${seen} games).`);
	}

	async function run(force = false) {
		if (busy || !ctx.isLoggedIn()) return;
		busy = true;
		try {
			if (cfg.sticker) await sticker(force).catch((err) => { note('sticker', false, err.message); ctx.debug(err.stack); });
			if (cfg.queue) await discovery(force).catch((err) => { note('queue', false, err.message); ctx.debug(err.stack); });
		} finally {
			busy = false;
			schedule();
		}
	}

	function schedule() {
		clearTimeout(timer);
		// next check: the start of the next Steam day, or in a few hours if today's run failed
		const doneToday = (!cfg.sticker || st.stickerDay === steamDay()) && (!cfg.queue || st.queueDay === steamDay());
		const wait = doneToday ? nextDayStart() - Date.now() + 5 * 60_000 : CHECK_MS;
		timer = setTimeout(() => run(), Math.max(60_000, wait));
	}

	return {
		snapshot: () => ({
			busy,
			doneToday: { sticker: st.stickerDay === steamDay(), queue: st.queueDay === steamDay() },
			nextDayAt: nextDayStart(),
			results: st.results.slice(0, 6),
		}),
		routes: {
			'POST settings'(body) {
				for (const k of ['sticker', 'queue']) if (k in body) cfg[k] = !!body[k];
				if ('queues' in body) cfg.queues = Math.max(1, Math.min(3, parseInt(body.queues, 10) || 1));
				ctx.saveConfig();
				schedule();
			},
			async 'POST run'() { await run(true); },
		},
		on: {
			loggedOn() { clearTimeout(timer); timer = setTimeout(() => run(), 2 * 60_000); },
			stop() { clearTimeout(timer); timer = null; },
		},
	};
}

module.exports = { create };
