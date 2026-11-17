'use strict';

// Steam tools that run next to the idler, sharing its Steam login. Each tool is one module:
//
//   module.exports = {
//     id, name, description,
//     defaults: { ... },               // its settings, kept in config.json under tools.<id>
//     available(ctx) -> { ok, reason },
//     create(ctx) -> {
//       snapshot() -> object,          // shown in the page under state.tools[]
//       routes: { action(body) },      // POST /api/tools/<id>/<action>
//       on: { loggedOn(), stop() },    // optional lifecycle hooks
//     },
//   };
//
// ctx gives a tool: client (steam-user), log(msg, notify), debug(msg), config (its settings),
// state (its own object in state.json), saveConfig(), saveState(), isLoggedIn(), accountId(),
// steamID64(), gameName(appid), playingElsewhere(), canSeePlaying(), openPath(dir), desktop, mobile.
//
// To add a tool: write src/tools/<id>/index.js and list it below; add its panel to public/index.html.

const TOOLS = [
	require('./screenshots'),
];

function createTools(host) {
	host.config.tools ??= {};
	host.state.tools ??= {};
	const list = TOOLS.map((def) => {
		const config = host.config.tools[def.id] = Object.assign({}, def.defaults, host.config.tools[def.id]);
		const state = host.state.tools[def.id] ??= {};
		const ctx = {
			...host.shared,
			id: def.id,
			config,
			state,
			log: (msg, notify) => host.log(msg, notify),
			debug: (msg) => host.debugLog.write(def.id, msg),
		};
		return { def, inst: def.create(ctx) };
	});

	const routes = {};
	for (const { def, inst } of list) {
		for (const [action, fn] of Object.entries(inst.routes || {})) routes[`POST /api/tools/${def.id}/${action}`] = fn;
	}

	return {
		routes,
		snapshot: () => list.map(({ def, inst }) => ({ id: def.id, name: def.name, description: def.description, ...inst.snapshot() })),
		emit(event, ...args) {
			for (const { def, inst } of list) {
				try { inst.on?.[event]?.(...args); } catch (err) { host.debugLog.write(def.id, `${event} hook failed: ${err.stack || err.message}`); }
			}
		},
	};
}

module.exports = { createTools };
