'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createUpdater, newer, pickAsset } = require('../src/lib/updater');

test('version comparison', () => {
	assert.ok(newer('v1.8.0', '1.7.0'));
	assert.ok(newer('v1.10.0', '1.9.9'));
	assert.ok(!newer('1.7.0', '1.7.0'));
	assert.ok(!newer('1.6.9', '1.7.0'));
	assert.ok(newer('1.13.0-beta.1', '1.12.0'), 'a beta of a newer version is newer');
	assert.ok(!newer('1.12.0-beta.1', '1.12.0'), 'a beta is older than its release');
	assert.ok(newer('1.12.0-beta.2', '1.12.0-beta.1'));
});

test('picks the right file for each kind of install', () => {
	const assets = ['Kettle-Setup-1.12.0.exe', 'Kettle-Portable-1.12.0.exe', 'Kettle-1.12.0-arm64.dmg', 'Kettle-1.12.0-x64.dmg', 'Kettle-1.12.0-x86_64.AppImage', 'Kettle-1.12.0-amd64.deb', 'Kettle-1.12.0-arm64-v8a.apk', 'Kettle-1.12.0-universal.apk'].map((name) => ({ name }));
	assert.strictEqual(pickAsset(assets, 'nsis').name, 'Kettle-Setup-1.12.0.exe');
	assert.strictEqual(pickAsset(assets, 'portable').name, 'Kettle-Portable-1.12.0.exe');
	assert.match(pickAsset(assets, 'dmg').name, /\.dmg$/);
	assert.match(pickAsset(assets, 'appimage').name, /\.AppImage$/);
	assert.match(pickAsset(assets, 'deb').name, /\.deb$/);
	assert.match(pickAsset(assets, 'android').name, /\.apk$/);
	// files from before the rename still match
	assert.strictEqual(pickAsset([{ name: 'Steam-Master-Idler-Setup-1.9.0.exe' }], 'nsis').name, 'Steam-Master-Idler-Setup-1.9.0.exe');
});

test('downloads, checks size and checksum, refuses a damaged file', async (t) => {
	const payload = crypto.randomBytes(200_000);
	let corrupt = false;
	let releases = null;
	const srv = http.createServer((req, res) => {
		if (req.url.startsWith('/repos')) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			const rel = (tag, prerelease) => ({ tag_name: tag, prerelease, draft: false, html_url: 'x', body: 'notes', assets: [{ name: `Kettle-${tag.slice(1)}-x86_64.AppImage`, size: payload.length, browser_download_url: `http://127.0.0.1:${srv.address().port}/file`, digest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}` }] });
			releases = [rel('v9.1.0-beta.1', true), rel('v9.0.0', false)];
			return res.end(JSON.stringify(req.url.includes('/latest') ? releases[1] : releases));
		}
		res.writeHead(200); res.end(corrupt ? Buffer.alloc(payload.length) : payload);
	});
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	t.after(() => srv.close());
	const realFetch = global.fetch;
	global.fetch = (url, o) => realFetch(String(url).replace('https://api.github.com', `http://127.0.0.1:${srv.address().port}`), o);
	t.after(() => { global.fetch = realFetch; });
	const prevAppImage = process.env.APPIMAGE;
	process.env.APPIMAGE = '/tmp/x.AppImage';
	t.after(() => { if (prevAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = prevAppImage; });
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-upd-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const events = new EventEmitter();
	const installs = [];
	events.on('installUpdate', (x) => installs.push(x));
	const cfg = { checkUpdates: true, autoUpdate: false, betaUpdates: false };
	const u = createUpdater({ version: '1.12.0', dataDir: dir, desktop: true, mobile: false, log: () => {}, debug: () => {}, events, getConfig: () => cfg });
	t.after(() => u.stop());
	await u.check();
	assert.strictEqual(u.snapshot().available, '9.0.0', 'stable channel: the release, not the beta');
	cfg.betaUpdates = true;
	await u.check();
	assert.strictEqual(u.snapshot().available, '9.1.0-beta.1', 'beta channel: the newest pre-release');
	await u.install();
	assert.strictEqual(installs[0].kind, 'appimage');
	assert.strictEqual(fs.statSync(installs[0].file).size, payload.length);
	corrupt = true;
	const u2 = createUpdater({ version: '1.12.0', dataDir: path.join(dir, '2'), desktop: true, mobile: false, log: () => {}, debug: () => {}, events: new EventEmitter(), getConfig: () => ({ checkUpdates: true }) });
	t.after(() => u2.stop());
	await u2.check();
	await assert.rejects(() => u2.download(), /damaged/);
	assert.deepStrictEqual(fs.readdirSync(path.join(dir, '2', 'updates')), [], 'damaged download removed');
});
