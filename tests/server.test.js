'use strict';

// The local server the page talks to, started for real (it doesn't connect to Steam without a sign-in).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-server-'));
process.env.IDLER_DATA_DIR = DATA;
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ logonID: 111, stats: { since: 1, idleMs: 0, gameMs: 0, sessions: 0, cards: 3, games: {} } }));
const server = require('../src/server');

let url;
const post = (p, body) => fetch(url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
	.then(async (r) => [r.status, await r.json().catch(() => null)]);
const loadedTools = () => Object.keys(require.cache).filter((k) => /src[\\/]tools[\\/]\w+[\\/]index\.js$/.test(k)).map((k) => k.split(/[\\/]tools[\\/]/)[1].split(/[\\/]/)[0]);

test.before(async () => { url = await server.start(0); });
test.after(async () => { await server.stop(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('a tool that is off is not loaded; switching it on and off', async () => {
	assert.ok(!loadedTools().includes('wishlist'));
	let [status, body] = await post('/api/tools/wishlist/check');
	assert.strictEqual(status, 400);
	assert.match(body.error, /Switch Wishlist sale alerts on first/);
	[status] = await post('/api/tools/wishlist/enable', { enabled: true });
	assert.strictEqual(status, 200);
	assert.ok(loadedTools().includes('wishlist'));
	assert.strictEqual((await fetch(`${url}/api/tools/wishlist/nope`)).status, 404);
	assert.strictEqual((await post('/api/tools/zzz/enable', { enabled: true }))[0], 404);
	await post('/api/tools/wishlist/enable', { enabled: false });
	const st = await (await fetch(`${url}/api/state`)).json();
	assert.strictEqual(st.tools.find((t) => t.id === 'wishlist').enabled, false);
	assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).tools.wishlist.enabled, false, 'saved');
});

test('the page only gets the library when it changed', async () => {
	const first = await (await fetch(`${url}/api/state`)).json();
	assert.ok(Array.isArray(first.library));
	const again = await (await fetch(`${url}/api/state?lib=${first.libraryVersion}`)).json();
	assert.strictEqual(again.library, undefined);
});

test('requests from other sites are refused', async () => {
	const r = await fetch(`${url}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
	assert.strictEqual(r.status, 403);
	const r2 = await fetch(`${url}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
	assert.strictEqual(r2.status, 403, 'not JSON: no cross-site form posts');
});

test('settings backup & sync', async () => {
	const drive = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-drive-'));
	try {
		assert.match((await post('/api/settings', { syncFolder: 'relative' }))[1].error, /full folder path/);
		await post('/api/settings', { syncFolder: drive, theme: 'light' });
		const [, r] = await post('/api/sync/backup-now');
		assert.match(r.file, /^kettle-/);
		const info = await (await fetch(`${url}/api/sync`)).json();
		assert.strictEqual(info.backups.length, 1);
		const backup = JSON.parse(fs.readFileSync(path.join(drive, 'Kettle', r.file), 'utf8'));
		assert.strictEqual(backup.config.theme, 'light');
		assert.ok(!('logonID' in backup.state));
		await post('/api/settings', { theme: 'dark' });
		const [, restored] = await post('/api/sync/restore', { file: info.backups[0].file });
		assert.strictEqual(restored.restartNeeded, true);
		assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')).theme, 'light');
		assert.strictEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8')).logonID, 111, 'this install keeps its ID');
		assert.match((await post('/api/sync/import', { backup: { hello: 1 } }))[1].error, /isn't a Kettle settings backup/);
	} finally {
		fs.rmSync(drive, { recursive: true, force: true });
		await post('/api/settings', { syncFolder: '' });
	}
});

test('the debug report has no secrets', async () => {
	const { createDebugLog } = require('../src/lib/debuglog');
	const log = createDebugLog(path.join(DATA, 'logs'));
	log.write('info', 'cookie steamLoginSecure=76561197960265729%7C%7CeyJabcdefghijklmn.eyJabcdefghijklmn.abcdefghijklmnop; password: hunter22 token=abcdef123456');
	const text = log.tail(5);
	assert.ok(!text.includes('hunter22') && !text.includes('abcdef123456') && !text.includes('eyJabcdefghijklmn'));
	const r = await fetch(`${url}/api/debug-report`);
	assert.strictEqual(r.status, 200);
	assert.match(r.headers.get('content-disposition'), /kettle-debug-/);
});
