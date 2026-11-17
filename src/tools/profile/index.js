'use strict';

// Tool: Profile rotator.
// Every few hours puts a different profile background / mini-profile background / avatar frame /
// animated avatar on your Steam profile, chosen from the items you own (all of them, or the ones you
// picked), at random or in order. Uses Steam's Player service (the same calls as the Points Shop
// "equip" buttons).

const { callService } = require('../../lib/steam-cm');

const SLOTS = {
	background: { list: 'profile_backgrounds', equipped: 'profile_background', set: 'SetProfileBackground', label: 'Profile background' },
	mini: { list: 'mini_profile_backgrounds', equipped: 'mini_profile_background', set: 'SetMiniProfileBackground', label: 'Mini-profile background' },
	frame: { list: 'avatar_frames', equipped: 'avatar_frame', set: 'SetAvatarFrame', label: 'Avatar frame' },
	avatar: { list: 'animated_avatars', equipped: 'animated_avatar', set: 'SetAnimatedAvatar', label: 'Animated avatar' },
};
const IMG = 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/';
const img = (p) => (!p ? null : /^https?:/.test(p) ? p : IMG + p);

function create(ctx) {
	const cfg = ctx.config;
	const st = ctx.state;
	st.pools ??= {};      // slot -> [communityitemid] picked (empty = all)
	st.pos ??= {};        // slot -> index for "in order"
	st.history ??= [];
	let owned = null;     // slot -> [{ id, name, game, image }]
	let equipped = {};    // slot -> id
	let timer = null;
	let busy = false;
	let error = null;

	async function load() {
		const [o, e] = await Promise.all([
			callService(ctx.client, 'Player.GetProfileItemsOwned#1', 'CPlayer_GetProfileItemsOwned_Request', 'CPlayer_GetProfileItemsOwned_Response', { language: 'english' }),
			callService(ctx.client, 'Player.GetProfileItemsEquipped#1', 'CPlayer_GetProfileItemsEquipped_Request', 'CPlayer_GetProfileItemsEquipped_Response', { steamid: ctx.steamID64(), language: 'english' }),
		]);
		owned = {};
		for (const [slot, def] of Object.entries(SLOTS)) {
			owned[slot] = (o[def.list] || []).map((i) => ({
				id: String(i.communityitemid), name: i.item_title || i.name || 'Item', appid: i.appid || null, game: i.appid ? ctx.gameName(i.appid) : '',
				image: img(i.image_small || i.image_large),
			}));
			equipped[slot] = e[def.equipped]?.communityitemid ? String(e[def.equipped].communityitemid) : null;
		}
	}

	function pick(slot) {
		const all = owned[slot] || [];
		const pool = st.pools[slot]?.length ? all.filter((i) => st.pools[slot].includes(i.id)) : all;
		const choices = pool.filter((i) => i.id !== equipped[slot]);
		if (!choices.length) return null;
		if (cfg.order === 'sequence') {
			st.pos[slot] = ((st.pos[slot] ?? -1) + 1) % pool.length;
			const next = pool[st.pos[slot]];
			return next.id === equipped[slot] ? pool[(st.pos[slot] = (st.pos[slot] + 1) % pool.length)] : next;
		}
		return choices[Math.floor(Math.random() * choices.length)];
	}

	async function rotate(manual = false) {
		if (busy || !ctx.isLoggedIn()) return;
		busy = true;
		const changed = [];
		try {
			await load();
			for (const slot of Object.keys(SLOTS)) {
				if (!cfg.slots?.[slot]) continue;
				const item = pick(slot);
				if (!item) continue;
				await callService(ctx.client, `Player.${SLOTS[slot].set}#1`, `CPlayer_${SLOTS[slot].set}_Request`, `CPlayer_${SLOTS[slot].set}_Response`, { communityitemid: item.id });
				equipped[slot] = item.id;
				changed.push(`${SLOTS[slot].label}: ${item.name}`);
			}
			st.lastAt = Date.now();
			error = null;
			if (changed.length) {
				st.history.unshift({ at: Date.now(), text: changed.join(' · ') });
				st.history.length = Math.min(st.history.length, 10);
				if (manual || cfg.notify) ctx.log(`🖼 Profile changed: ${changed.join(', ')}.`, cfg.notify && !manual);
			} else if (manual) {
				ctx.log('🖼 Nothing to change: pick at least one kind of item you own more than one of.');
			}
			ctx.saveState();
		} catch (err) {
			error = err.message;
			ctx.debug(`rotate: ${err.stack || err.message}`);
			if (manual) throw err;
		} finally {
			busy = false;
			schedule();
		}
	}

	function schedule() {
		clearTimeout(timer);
		const every = cfg.everyHours * 3_600_000;
		timer = setTimeout(() => rotate(), Math.max(60_000, (st.lastAt || 0) + every - Date.now()));
	}

	return {
		snapshot: () => ({
			busy, error, lastAt: st.lastAt || null, nextAt: (st.lastAt || Date.now()) + cfg.everyHours * 3_600_000,
			history: st.history.slice(0, 5),
			counts: owned ? Object.fromEntries(Object.keys(SLOTS).map((s) => [s, owned[s].length])) : null,
		}),
		routes: {
			async 'GET items'() {
				if (!ctx.isLoggedIn()) throw new Error('Log in first');
				await load();
				return { slots: Object.fromEntries(Object.entries(SLOTS).map(([slot, def]) => [slot, { label: def.label, items: owned[slot], equipped: equipped[slot], pool: st.pools[slot] || [] }])) };
			},
			'POST settings'(body) {
				if (body.slots && typeof body.slots === 'object') cfg.slots = Object.fromEntries(Object.keys(SLOTS).map((s) => [s, !!(body.slots[s] ?? cfg.slots?.[s])]));
				if ([1, 3, 6, 12, 24, 48, 168].includes(+body.everyHours)) cfg.everyHours = +body.everyHours;
				if (body.order === 'random' || body.order === 'sequence') cfg.order = body.order;
				if ('notify' in body) cfg.notify = !!body.notify;
				ctx.saveConfig();
				schedule();
			},
			// { slot, ids: [...] } - the items to rotate through (empty: all you own)
			'POST pool'(body) {
				if (!SLOTS[body.slot]) throw new Error('Bad slot');
				st.pools[body.slot] = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 1000);
				ctx.saveState();
			},
			async 'POST rotate'() { await rotate(true); if (error) throw new Error(error); },
		},
		on: {
			loggedOn: schedule,
			stop() { clearTimeout(timer); timer = null; owned = null; },
		},
	};
}

module.exports = { create, SLOTS };
