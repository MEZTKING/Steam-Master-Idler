'use strict';

// Tool: Free game claimer.
// Paste store links or IDs of free games (free-to-play, or paid games that are free to keep for a
// while) and they're added to your account:
//   - apps: first the Steam client's "request free license" (works for free-on-demand apps), then the
//     app's free package from the store (free-to-keep promotions);
//   - packages (store.steampowered.com/sub/123): added through the store's "add free license".
// Nothing runs in the background: it only does something when you press Claim.

const { webRequest } = require('../../lib/web');
const { getStoreItems } = require('../../lib/store');

// "https://store.steampowered.com/app/440/Team_Fortress_2/" | "440" | "app/440" | "sub/123" | "s/123"
function parseInputs(text) {
	const out = [];
	for (const raw of String(text).split(/[\s,;]+/).filter(Boolean)) {
		let m = raw.match(/(?:^|\/)(app|sub|a|s)[/:](\d+)/i);
		if (m) { out.push({ kind: /^s/i.test(m[1]) ? 'sub' : 'app', id: +m[2], raw }); continue; }
		m = raw.match(/^\d+$/);
		if (m) { out.push({ kind: 'app', id: +raw, raw }); continue; }
		out.push({ kind: 'bad', id: 0, raw });
	}
	return out.slice(0, 50);
}

function create(ctx) {
	const st = ctx.state;
	st.history ??= [];
	let busy = false;

	const hasPackage = (subid) => (ctx.client.licenses || []).some((l) => l.package_id === subid);

	function waitForLicense(subid, ms = 10_000) {
		return new Promise((resolve) => {
			if (hasPackage(subid)) return resolve(true);
			const done = () => { if (hasPackage(subid)) { clearTimeout(t); ctx.client.removeListener('licenses', done); resolve(true); } };
			const t = setTimeout(() => { ctx.client.removeListener('licenses', done); resolve(hasPackage(subid)); }, ms);
			ctx.client.on('licenses', done);
		});
	}

	async function claimPackage(subid) {
		if (hasPackage(subid)) return { ok: true, text: 'Already on your account.' };
		const web = ctx.web();
		await webRequest(web, `https://store.steampowered.com/freelicense/addfreelicense/${subid}`, { method: 'POST', form: { ajax: 'true', sessionid: web?.sessionID || '' } });
		return (await waitForLicense(subid)) ? { ok: true, text: 'Added to your account.' } : { ok: false, text: "Steam didn't add it (the package may not be free right now)." };
	}

	async function claimApp(appid) {
		if (ctx.ownsApp(appid)) return { ok: true, text: 'Already in your library.' };
		try {
			const { grantedAppIds, grantedPackageIds } = await ctx.client.requestFreeLicense([appid]);
			if (grantedAppIds?.length || grantedPackageIds?.length) return { ok: true, text: 'Added to your library.' };
		} catch (err) {
			ctx.debug(`requestFreeLicense ${appid}: ${err.message}`);
		}
		// free-to-keep promotions: claim the app's free package from the store
		const item = (await getStoreItems(ctx.client, [appid], { country: ctx.country(), allOptions: true })).get(appid);
		if (!item?.visible) return { ok: false, text: 'Not found on the store (or not sold in your country).' };
		const free = (item.options || []).find((o) => o.packageid && o.finalCents === 0);
		if (!free) return { ok: false, name: item.name, text: item.price ? `Not free right now (${item.price}).` : 'Not free right now.' };
		try {
			return { name: item.name, ...(await claimPackage(free.packageid)) };
		} catch (err) {
			return { ok: false, name: item.name, text: err.message };
		}
	}

	async function claim(text) {
		if (busy) throw new Error('Still working on the last list.');
		if (!ctx.isLoggedIn()) throw new Error('Log in first');
		const inputs = parseInputs(text);
		if (!inputs.length) throw new Error('Paste a store link or AppID.');
		busy = true;
		const results = [];
		try {
			for (const inp of inputs) {
				let r;
				try {
					r = inp.kind === 'bad' ? { ok: false, text: "That isn't a store link or ID." }
						: inp.kind === 'sub' ? await claimPackage(inp.id) : await claimApp(inp.id);
				} catch (err) {
					r = { ok: false, text: err.message };
				}
				const name = r.name || (inp.kind === 'app' ? ctx.gameName(inp.id) : inp.kind === 'sub' ? `Package ${inp.id}` : inp.raw);
				results.push({ input: inp.raw, kind: inp.kind, id: inp.id, name, ok: r.ok, text: r.text, at: Date.now() });
			}
		} finally {
			busy = false;
		}
		st.history = [...results, ...st.history].slice(0, 30);
		ctx.saveState();
		const added = results.filter((r) => r.ok && /^Added/.test(r.text));
		if (added.length) {
			ctx.log(`🆓 Added to your account: ${added.map((r) => r.name).join(', ')}.`, true);
			ctx.refreshLibrary().catch(() => {});
		}
		return { results };
	}

	return {
		snapshot: () => ({ busy, history: st.history.slice(0, 10) }),
		routes: {
			'POST claim': (body) => claim(body.text),
			'POST clear-history'() { st.history = []; ctx.saveState(); },
		},
		on: {},
	};
}

module.exports = { create, parseInputs };
