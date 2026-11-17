'use strict';

// Tool: Library cleanup.
// Everything here is worked out on demand when you open it, nothing runs in the background:
//   - never played / barely played / not played for over a year (from your library)
//   - still refundable: bought in the last 14 days and played under 2 hours (Steam's refund rule),
//     from your licenses + package contents (PICS)
//   - DLC you own for a game you don't own (an on-demand scan of all your licenses)

const SteamUser = require('steam-user');

const DAY = 86_400_000;
const REFUND_DAYS = 14;
const REFUND_MIN = 120;
// how a license was obtained that Steam doesn't refund
const NOT_BOUGHT = new Set(['None', 'ActivationCode', 'GuestPass', 'HardwarePromo', 'AutoGrant', 'Complimentary', 'FamilyGroup', 'StorePromotion', 'Valve', 'OEMTicket', 'MasterComp']
	.map((k) => SteamUser.EPaymentMethod[k]).filter((v) => v != null));

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function create(ctx) {
	const cfg = ctx.config;
	let dlcScan = null;   // { running, done, total, results, at, error }

	async function packageApps(packageIds) {
		const out = new Map();   // packageid -> [appids]
		for (const part of chunk(packageIds, 200)) {
			const { packages } = await ctx.client.getProductInfo([], part.map((packageid) => ({ packageid })), true);
			for (const [id, p] of Object.entries(packages || {})) out.set(+id, (p.packageinfo?.appids || []).map(Number));
		}
		return out;
	}

	async function refundable() {
		const licenses = (ctx.client.licenses || []).filter((l) => (Date.now() - l.time_created * 1000) < REFUND_DAYS * DAY && !NOT_BOUGHT.has(l.payment_method) && l.package_id);
		if (!licenses.length) return [];
		const apps = await packageApps(licenses.map((l) => l.package_id));
		const lib = new Map(ctx.library().map((g) => [g.appid, g]));
		const out = [];
		for (const l of licenses) {
			for (const appid of apps.get(l.package_id) || []) {
				const g = lib.get(appid);
				if (!g) continue;   // DLC / tools: not in the games list
				const until = l.time_created * 1000 + REFUND_DAYS * DAY;
				out.push({ appid, name: g.name, minutes: g.minutes, boughtAt: l.time_created * 1000, until, ok: g.minutes < REFUND_MIN });
			}
		}
		return out.sort((a, b) => a.until - b.until);
	}

	// DLC on your account whose base game isn't: every license -> its apps -> app type + parent
	async function scanDlc() {
		if (dlcScan?.running) return;
		dlcScan = { running: true, done: 0, total: 0, results: [], at: null, error: null };
		try {
			const pkgs = [...new Set((ctx.client.licenses || []).map((l) => l.package_id).filter(Boolean))];
			dlcScan.total = pkgs.length;
			const appIds = new Set();
			for (const part of chunk(pkgs, 200)) {
				const m = await packageApps(part);
				for (const ids of m.values()) ids.forEach((a) => appIds.add(a));
				dlcScan.done += part.length;
			}
			const owned = new Set(ctx.library().map((g) => g.appid));
			const ownedAny = new Set(appIds);   // apps on any of your licenses
			const notInLib = [...appIds].filter((a) => !owned.has(a));
			dlcScan.total += notInLib.length;
			for (const part of chunk(notInLib, 200)) {
				const { apps } = await ctx.client.getProductInfo(part, [], true);
				for (const [id, a] of Object.entries(apps || {})) {
					const c = a.appinfo?.common || {};
					const parent = +(c.parent || a.appinfo?.extended?.dlcforappid || 0);
					if (String(c.type).toLowerCase() === 'dlc' && parent && !owned.has(parent) && !ownedAny.has(parent)) {
						dlcScan.results.push({ appid: +id, name: c.name || `App ${id}`, parent, parentName: null });
					}
				}
				dlcScan.done += part.length;
			}
			// names of the missing base games
			const parents = [...new Set(dlcScan.results.map((r) => r.parent))];
			for (const part of chunk(parents, 200)) {
				const { apps } = await ctx.client.getProductInfo(part, [], true);
				for (const r of dlcScan.results) if (apps?.[r.parent]) r.parentName = apps[r.parent].appinfo?.common?.name || null;
			}
			dlcScan.at = Date.now();
			ctx.log(`🧹 DLC scan done: ${dlcScan.results.length} DLC for games you don't own.`);
		} catch (err) {
			dlcScan.error = err.message;
			ctx.debug(`dlc scan: ${err.stack || err.message}`);
		} finally {
			dlcScan.running = false;
		}
	}

	return {
		snapshot: () => ({ dlcScan: dlcScan && { running: dlcScan.running, done: dlcScan.done, total: dlcScan.total, found: dlcScan.results.length, at: dlcScan.at, error: dlcScan.error } }),
		routes: {
			async 'GET data'() {
				const lib = ctx.library();
				const barely = cfg.barelyMinutes || 30;
				const yearAgo = Date.now() - 365 * DAY;
				const slim = (g) => ({ appid: g.appid, name: g.name, minutes: g.minutes, lastPlayed: g.lastPlayed || null });
				let refunds = [];
				let refundError = null;
				if (ctx.isLoggedIn()) { try { refunds = await refundable(); } catch (err) { refundError = err.message; } }
				return {
					library: lib.length,
					never: lib.filter((g) => !g.minutes).map(slim).sort((a, b) => a.name.localeCompare(b.name)),
					barely: lib.filter((g) => g.minutes > 0 && g.minutes < barely).map(slim).sort((a, b) => a.minutes - b.minutes),
					forgotten: lib.filter((g) => g.minutes > 0 && g.lastPlayed && g.lastPlayed < yearAgo).map(slim).sort((a, b) => a.lastPlayed - b.lastPlayed),
					barelyMinutes: barely,
					refunds, refundError,
					dlc: dlcScan && !dlcScan.running ? dlcScan.results : null,
				};
			},
			'POST settings'(body) {
				if ('barelyMinutes' in body) cfg.barelyMinutes = Math.max(5, Math.min(600, parseInt(body.barelyMinutes, 10) || 30));
				ctx.saveConfig();
			},
			'POST scan-dlc'() {
				if (!ctx.isLoggedIn()) throw new Error('Log in first');
				scanDlc();
			},
		},
		on: { stop() { dlcScan = null; } },
	};
}

module.exports = { create };
