'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome, steamUserdata, toolCtx } = require('./helpers');
const local = require('../src/lib/steam-local');
const { getVdfValue } = require('../src/lib/vdf-edit');
const launch = require('../src/tools/launch');

const ORIGINAL = '"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n\t\t\t\t\t"730"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1700000000"\n\t\t\t\t\t\t"LaunchOptions"\t\t"-novid"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\t"SomethingElse"\t\t"1"\n\t\t\t}\n\t\t}\n\t}\n}\n';

function setup(t) {
	const home = tempHome(t);
	const dir = path.join(steamUserdata(home, 7), 'config');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'localconfig.vdf');
	fs.writeFileSync(file, ORIGINAL);
	// a pretend Steam app
	const steam = { running: true, calls: [] };
	const saved = { ...local };
	Object.assign(local, {
		isSteamRunning: async () => steam.running,
		closeSteam: async () => { steam.calls.push('close'); steam.running = false; return true; },
		startSteam: () => { steam.calls.push('start'); steam.running = true; return true; },
	});
	t.after(() => Object.assign(local, saved));
	const ctx = toolCtx({ accountId: () => 7, gameName: (a) => ({ 730: 'Counter-Strike 2', 440: 'Team Fortress 2' }[a] || `App ${a}`) });
	const tool = launch.create(ctx);
	t.after(() => tool.on.stop());
	const opts = (appid) => getVdfValue(fs.readFileSync(file, 'utf8'), [...launch.APPS_PATH, String(appid)], 'LaunchOptions');
	return { tool, ctx, steam, file, opts, home };
}

test('the game\'s current options become its Default', async (t) => {
	const { tool } = setup(t);
	const g = await tool.routes['GET game']({ appid: '730' });
	assert.strictEqual(g.current, '-novid');
	assert.strictEqual(g.defaultOptions, '-novid');
	assert.strictEqual(g.active, 'default');
});

test('while Steam runs: "when Steam closes" waits, "now" restarts Steam', async (t) => {
	const { tool, ctx, steam, opts } = setup(t);
	await tool.routes['GET game']({ appid: '730' });
	tool.routes['POST save']({ appid: 730, configs: [{ name: 'Performance', options: '-novid -high' }] });
	const perf = ctx.state.games[730].configs[0].id;
	assert.match(perf, /^[a-z0-9]{4,12}$/, 'new configs get an id');
	const r = await tool.routes['POST switch']({ appid: 730, config: perf, mode: 'later' });
	assert.deepStrictEqual(r, { applied: false, waiting: true });
	assert.strictEqual(opts(730), '-novid', 'not written while Steam runs');
	steam.running = false;
	await tool.routes['POST apply-pending']({});
	assert.strictEqual(opts(730), '-novid -high');
	assert.deepStrictEqual(ctx.state.pending, {});
	steam.running = true;
	const now = await tool.routes['POST switch']({ appid: 730, config: 'default', mode: 'now' });
	assert.deepStrictEqual(now, { applied: true, restarted: true });
	assert.strictEqual(opts(730), '-novid');
	assert.deepStrictEqual(steam.calls, ['close', 'start']);
});

test('a game without an entry, Steam closed: written right away; rest of the file kept; backups made', async (t) => {
	const { tool, ctx, steam, file, opts, home } = setup(t);
	steam.running = false;
	await tool.routes['GET game']({ appid: '440' });
	tool.routes['POST save']({ appid: 440, configs: [{ name: 'DX11', options: '-dx11 "quoted path"' }] });
	const r = await tool.routes['POST switch']({ appid: 440, config: ctx.state.games[440].configs[0].id });
	assert.strictEqual(r.applied, true);
	assert.strictEqual(opts(440), '-dx11 "quoted path"');
	const text = fs.readFileSync(file, 'utf8');
	assert.ok(text.includes('"SomethingElse"\t\t"1"') && text.includes('"LastPlayed"\t\t"1700000000"'));
	const o = await tool.routes['GET overview']();
	assert.strictEqual(o.games.find((g) => g.appid === 440).active, ctx.state.games[440].configs[0].id, 'shows which config is in use');
	assert.strictEqual(fs.readdirSync(path.join(home, 'data', 'launch-option-backups')).length, 1);
});
