'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome, writeShot, fakeClient, toolCtx, encode, EMsg, wait } = require('./helpers');

// ---- achievements ----

// binary KeyValues, the way Steam sends a game's stats schema
function kv(obj) {
	const parts = [];
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v === 'object') parts.push(Buffer.from([0]), Buffer.from(`${k}\0`), kv(v));
		else if (typeof v === 'number') { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(Buffer.from([2]), Buffer.from(`${k}\0`), b); }
		else parts.push(Buffer.from([1]), Buffer.from(`${k}\0`), Buffer.from(`${v}\0`));
	}
	parts.push(Buffer.from([8]));
	return Buffer.concat(parts);
}

test('achievements: reads the schema, unlocks/locks, skips protected, retries in-game', async (tt) => {
	const schema = kv({ 480: { gamename: 'Spacewar', stats: { 1: { type: '4', id: '1', bits: {
		0: { name: 'ACH_A', bit: 0, display: { name: { english: 'Winner' }, desc: { english: 'Win' }, hidden: '0', icon: 'a.jpg', icon_gray: 'ag.jpg' } },
		1: { name: 'ACH_B', bit: 1, display: { name: { english: 'Champion' }, hidden: '1', icon: 'b.jpg' } },
		2: { name: 'ACH_P', bit: 2, permission: 2, display: { name: { english: 'Server only' } } },
	} } } } });
	let value = 1;
	let playing = [];
	const client = fakeClient({
		// Steam may answer without our job id: it arrives through the message handler
		ClientGetUserStats: () => {
			setImmediate(() => client._handlerManager.emit(client, EMsg.ClientGetUserStatsResponse,
				encode('CMsgClientGetUserStatsResponse', { game_id: '480', eresult: 1, crc_stats: 7, schema, stats: [{ stat_id: 1, stat_value: value }], achievement_blocks: [{ achievement_id: 1, unlock_time: [1700000000] }] }),
				{ msg: EMsg.ClientGetUserStatsResponse }));
			return null;
		},
		// only accepted while "in the game"
		ClientStoreUserStats2: (r) => {
			const ok = playing.includes(480);
			if (ok) value = r.stats[0].stat_value;
			return ['CMsgClientStoreUserStatsResponse', { game_id: '480', eresult: ok ? 1 : 15, crc_stats: 7 }, {}];
		},
	}, { ClientStoreUserStats2: 'CMsgClientStoreUserStats2' });
	const ctx = toolCtx({ client, withGamePlaying: async (appid, fn) => { playing = [appid]; try { return await fn(); } finally { playing = []; } } });
	const t = require('../src/tools/achievements').create(ctx);
	tt.after(() => t.on.stop());
	let g = await t.routes['GET game']({ appid: '480' });
	assert.strictEqual(g.name, 'Spacewar');
	assert.deepStrictEqual(g.achievements.map((a) => [a.apiName, a.unlocked, a.protected, a.hidden]), [['ACH_A', true, false, false], ['ACH_B', false, false, true], ['ACH_P', false, true, false]]);
	assert.strictEqual(g.achievements[0].unlockedAt, 1700000000000);
	g = await t.routes['POST apply']({ appid: 480, changes: [{ id: '1_1', unlocked: true }, { id: '1_2', unlocked: true }] });
	assert.strictEqual(value, 3, 'bit 1 set, protected bit 2 left alone');
	g = await t.routes['POST apply']({ appid: 480, changes: [{ id: '1_0', unlocked: false }] });
	assert.strictEqual(value, 2);
	assert.strictEqual(g.unlocked, 1);
	t.on.stop();
});

// ---- store-based tools ----

function storeClient(extra = {}) {
	return fakeClient({
		'StoreBrowse.GetItems#1': (r) => ['CStoreBrowse_GetItems_Response', { store_items: r.ids.map((i) => ({ appid: i.appid, id: i.appid, success: 1, visible: i.appid !== 30, name: `Game ${i.appid}`,
			// steam-user's store definitions predate is_free_temporarily: free weekends come as free_weekend
			free_weekend: i.appid === 20 ? { start_time: Math.floor(Date.now() / 1000) - 3600, end_time: Math.floor(Date.now() / 1000) + 86_400 } : undefined,
			best_purchase_option: { packageid: 9, final_price_in_cents: i.appid === 10 ? 499 : i.appid === 40 ? 0 : 1999, original_price_in_cents: 1999, formatted_final_price: i.appid === 10 ? '4,99€' : '19,99€', discount_pct: i.appid === 10 ? 75 : i.appid === 40 ? 100 : 0 },
			purchase_options: [{ packageid: 555, final_price_in_cents: 0 }] })) }],
		...extra,
	}, { 'StoreBrowse.GetItems#1': 'CStoreBrowse_GetItems_Request' });
}

test('wishlist: deals, your price, free weekend / free to keep, no longer sold', async (tt) => {
	const { defineTypes } = require('../src/lib/steam-cm');
	require('../src/tools/wishlist');   // defines the Wishlist message types
	const { Root } = require(require.resolve('protobufjs', { paths: [path.dirname(require.resolve('steam-user'))] }));
	const R = Root.fromJSON({ nested: { W: { fields: { items: { rule: 'repeated', type: 'I', id: 1 } } }, I: { fields: { appid: { type: 'uint32', id: 1 } } } } }).lookupType('W');
	const client = storeClient({ 'Wishlist.GetWishlist#1': () => null });
	client._send = ((orig) => (h, body, cb) => {
		if (h.proto?.target_job_name === 'Wishlist.GetWishlist#1') return setImmediate(() => cb(Buffer.from(R.encode(R.fromObject({ items: [10, 20, 30, 40, 50].map((appid) => ({ appid })) })).finish()), { proto: { eresult: 1 } }));
		return orig(h, body, cb);
	})(client._send);
	assert.ok(defineTypes);
	const ctx = toolCtx({ client, config: { minDiscount: 50, everyHours: 6, delistWatch: true, freeAlerts: true } });
	const t = require('../src/tools/wishlist').create(ctx);
	tt.after(() => t.on.stop());
	t.routes['POST target']({ appid: 50, price: '20' });
	await t.routes['POST check']();
	const items = Object.fromEntries(t.routes['GET data']().items.map((i) => [i.appid, i]));
	assert.ok(items[10].deal, '75% off');
	assert.ok(items[50].deal, 'at your price');
	assert.strictEqual(items[20].free, 'weekend');
	assert.strictEqual(items[40].free, 'keep');
	assert.strictEqual(items[30].delist.kind, 'gone', 'hidden from the store');
	assert.ok(ctx.logs.some((l) => /On sale from your wishlist: .*Game 10 −75%/.test(l)));
	assert.ok(ctx.logs.some((l) => /Free to keep from your wishlist: Game 40/.test(l)));
	const before = ctx.logs.length;
	await t.routes['POST check']();
	assert.ok(!ctx.logs.slice(before).some((l) => /On sale from/.test(l)), 'each deal announced once');
});

test('free games: input parsing, claims the free package of a free-to-keep game', async () => {
	const fg = require('../src/tools/freegames');
	assert.deepStrictEqual(fg.parseInputs('https://store.steampowered.com/app/440/TF2/ sub/123 570, s/9 hello').map((x) => [x.kind, x.id]),
		[['app', 440], ['sub', 123], ['app', 570], ['sub', 9], ['bad', 0]]);
	const client = storeClient();
	client.requestFreeLicense = async () => ({ grantedAppIds: [], grantedPackageIds: [] });
	const ctx = toolCtx({ client, web: () => null });
	const t = fg.create(ctx);
	const r = await t.routes['POST claim']({ text: '10 junk' });
	assert.strictEqual(r.results[0].name, 'Game 10');
	assert.match(r.results[0].text, /web session/, 'needs the web session for the store');
	assert.strictEqual(r.results[1].ok, false);
});

test('sale helper: claims the sticker and goes through the Discovery Queue once a day', async (tt) => {
	require('../src/tools/sale');
	const { Root } = require(require.resolve('protobufjs', { paths: [path.dirname(require.resolve('steam-user'))] }));
	const CanClaim = Root.fromJSON({ nested: { C: { fields: { can_claim: { type: 'bool', id: 1 } } } } }).lookupType('C');
	const seen = [];
	const client = fakeClient({
		'Store.GetDiscoveryQueue#1': () => ['CStore_GetDiscoveryQueue_Response', { appids: [1, 2, 3] }],
		'Store.SkipDiscoveryQueueItem#1': (r) => { seen.push(r.appid); return ['CStore_SkipDiscoveryQueueItem_Response', {}]; },
		'SaleItemRewards.ClaimItem#1': () => [null, null],
	}, { 'Store.SkipDiscoveryQueueItem#1': 'CStore_SkipDiscoveryQueueItem_Request' });
	client._send = ((orig) => (h, body, cb) => (h.proto?.target_job_name === 'SaleItemRewards.CanClaimItem#1'
		? setImmediate(() => cb(Buffer.from(CanClaim.encode({ can_claim: true }).finish()), { proto: { eresult: 1 } })) : orig(h, body, cb)))(client._send);
	const ctx = toolCtx({ client, config: { queues: 1, sticker: true, queue: true } });
	const t = require('../src/tools/sale').create(ctx);
	tt.after(() => t.on.stop());
	await t.routes['POST run']();
	assert.deepStrictEqual(seen, [1, 2, 3]);
	assert.deepStrictEqual(t.snapshot().doneToday, { sticker: true, queue: true });
	assert.ok(ctx.logs.some((l) => /Claimed today's free Steam sale item/.test(l)));
	t.on.stop();
});

test('market: price parsing in any currency', () => {
	const { priceCents, kindOf } = require('../src/tools/market');
	for (const [text, cents] of [['1.234,56€', 123456], ['$1,234.56', 123456], ['0,03€', 3], ['$0.12', 12], ['1 234,56 pуб.', 123456], ['¥ 1,234', 123400], ['CDN$ 0.25', 25], ['R$ 0,50', 50]]) {
		assert.strictEqual(priceCents(text), cents, text);
	}
	assert.strictEqual(kindOf('Portal 2 Foil Trading Card'), 'Foil card');
	assert.strictEqual(kindOf('Portal 2 Profile Background'), 'Background');
});

test('badges: page and booster creator parsing', () => {
	const { parseBadges, parseBoosters } = require('../src/tools/badges');
	const html = '<div class="badge_row is_link"><a href="https://steamcommunity.com/id/me/gamecards/10/"></a><div class="badge_title">Game&nbsp;<span class="badge_view_details">View details</span></div><div>Level 2, 200 XP</div><span class="progress_info_bold">No card drops remaining</span><div class="badge_progress_info">6 of 6 cards collected</div></div>'
		+ '<div class="badge_row is_link"><a href="https://steamcommunity.com/id/me/gamecards/30/"></a><div class="badge_title">Other</div><span class="progress_info_bold">2 card drops remaining</span><div class="badge_progress_info">3 of 8 cards collected</div></div>';
	const { badges } = parseBadges(html);
	assert.deepStrictEqual(badges.map((b) => [b.appid, b.level, b.owned, b.total, b.drops, b.craftable]), [[10, 2, 6, 6, 0, true], [30, 0, 3, 8, 2, false]]);
	const boosters = parseBoosters('CBoosterCreatorPage.Init(\n[{"appid":10,"name":"G","price":"400"},{"appid":30,"name":"O","price":"600","unavailable":true,"available_at_time":"20 Nov"}],\n 1)');
	assert.deepStrictEqual(boosters.map((b) => [b.appid, b.gems, b.available]), [[10, 400, true], [30, 600, false]]);
});

test('playtime: day-by-day history from library differences; Monday report time', () => {
	const lib = [{ appid: 10, name: 'A', minutes: 100 }, { appid: 20, name: 'B', minutes: 0 }];
	const ctx = toolCtx({ library: () => lib, gameName: (a) => (a === 10 ? 'A' : 'B'), config: { weekly: true } });
	const pt = require('../src/tools/playtime');
	const t = pt.create(ctx);
	t.routes['POST report-now']();   // first reading
	lib[0].minutes += 90;
	t.routes['POST report-now']();
	const d = t.routes['GET data']({ days: '7' });
	assert.strictEqual(d.total, 90);
	assert.deepStrictEqual(d.games.map((g) => [g.appid, g.minutes]), [[10, 90]]);
	assert.strictEqual(d.never.count, 1);
	const next = new Date(pt.nextMonday(new Date('2026-11-17T12:00:00').getTime()));
	assert.deepStrictEqual([next.getDay(), next.getDate(), next.getHours()], [1, 23, 10]);
	t.on.stop();
});

test('library cleanup: refundable purchases (not gifts/keys/old), orphan DLC', async () => {
	const now = Date.now();
	const lib = [{ appid: 10, name: 'Old', minutes: 600 }, { appid: 20, name: 'Never', minutes: 0 }, { appid: 40, name: 'New', minutes: 45, lastPlayed: now }];
	const client = fakeClient({});
	client.licenses = [{ package_id: 500, time_created: Math.floor((now - 3 * 86_400_000) / 1000), payment_method: 2 }, { package_id: 501, time_created: Math.floor((now - 30 * 86_400_000) / 1000), payment_method: 2 }, { package_id: 502, time_created: Math.floor(now / 1000), payment_method: 1024 }];
	client.getProductInfo = async (apps, pkgs) => ({
		packages: Object.fromEntries(pkgs.map((p) => [p.packageid, { packageinfo: { appids: p.packageid === 500 ? [40, 41] : p.packageid === 501 ? [10] : [20] } }])),
		apps: Object.fromEntries(apps.map((a) => [a, { appinfo: { common: a === 41 ? { type: 'DLC', name: 'Some DLC', parent: 99 } : { type: 'Game', name: a === 99 ? 'Base Game' : `G${a}` } } }])),
	});
	const t = require('../src/tools/cleanup').create(toolCtx({ client, library: () => lib, config: { barelyMinutes: 30 } }));
	const d = await t.routes['GET data']();
	assert.deepStrictEqual(d.refunds.map((r) => [r.name, r.ok]), [['New', true]]);
	assert.deepStrictEqual(d.never.map((g) => g.name), ['Never']);
	t.routes['POST scan-dlc']();
	await wait(100);
	assert.deepStrictEqual((await t.routes['GET data']()).dlc.map((x) => [x.name, x.parentName]), [['Some DLC', 'Base Game']]);
});

test('profile rotator: in order, from the picked items', async (tt) => {
	let equipped = '111';
	const set = [];
	const client = fakeClient({
		'Player.GetProfileItemsOwned#1': () => ['CPlayer_GetProfileItemsOwned_Response', { profile_backgrounds: [{ communityitemid: '111', item_title: 'A' }, { communityitemid: '222', item_title: 'B' }, { communityitemid: '333', item_title: 'C' }] }],
		'Player.GetProfileItemsEquipped#1': () => ['CPlayer_GetProfileItemsEquipped_Response', { profile_background: { communityitemid: equipped } }],
		'Player.SetProfileBackground#1': (r) => { equipped = r.communityitemid; set.push(r.communityitemid); return ['CPlayer_SetProfileBackground_Response', {}]; },
	}, { 'Player.SetProfileBackground#1': 'CPlayer_SetProfileBackground_Request' });
	const t = require('../src/tools/profile').create(toolCtx({ client, config: { everyHours: 24, order: 'sequence', slots: { background: true }, notify: false } }));
	tt.after(() => t.on.stop());
	await t.routes['POST rotate']();
	await t.routes['POST rotate']();
	t.routes['POST pool']({ slot: 'background', ids: ['111', '333'] });
	await t.routes['POST rotate']();
	assert.deepStrictEqual(set, ['222', '333', '111']);
	t.on.stop();
});

test('backups: playtime files and screenshots copied once', async (t) => {
	const home = tempHome(t);
	writeShot(home, 10, '20261101100000_1.jpg');
	const lib = [{ appid: 10, name: 'Game: One', minutes: 90 }];
	const b = require('../src/tools/backups').create(toolCtx({ library: () => lib, gameName: () => 'Game: One', config: { folder: '', every: 'weekly', keep: 2, achievements: false, screenshots: true, notify: false } }));
	t.after(() => b.on.stop());
	b.routes['POST run']();
	await wait(300);
	const out = path.join(home, 'data', 'backups');
	const dated = fs.readdirSync(out).filter((d) => /^\d{4}-/.test(d));
	assert.strictEqual(dated.length, 1);
	assert.match(fs.readFileSync(path.join(out, dated[0], 'playtime.csv'), 'utf8'), /^appid,name,minutes,hours,last_played\n10,Game: One,90,1.5,/);
	assert.ok(fs.existsSync(path.join(out, 'screenshots', 'Game_ One', '20261101100000_1.jpg')));
});
