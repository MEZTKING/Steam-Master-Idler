'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tempHome, setRunningApp, writeShot, fakeClient, storageServer, toolCtx, until, wait, jpeg } = require('./helpers');
const screenshots = require('../src/tools/screenshots');
const { jpegSize, PRIVACY } = require('../src/tools/screenshots/uploader');

const REQ = {
	'Cloud.ClientBeginFileUpload#1': 'CCloud_ClientBeginFileUpload_Request',
	'Cloud.ClientCommitFileUpload#1': 'CCloud_ClientCommitFileUpload_Request',
	'Cloud.EnumerateUserFiles#1': 'CCloud_EnumerateUserFiles_Request',
	ClientUCMAddScreenshot: 'CMsgClientUCMAddScreenshot',
};

// a fake Steam: cloud uploads go to `storage`; addScreenshot answers with `ucm(req)` (EResult)
function steam(storage, { ucm = () => 1, cloudFiles = [] } = {}) {
	return fakeClient({
		'Cloud.EnumerateUserFiles#1': () => ['CCloud_EnumerateUserFiles_Response', { total_files: cloudFiles.length, files: cloudFiles }],
		'Cloud.ClientBeginFileUpload#1': (r) => ['CCloud_ClientBeginFileUpload_Response', { block_requests: [{ url_host: storage.host, url_path: `/${r.filename}`, http_method: 4, block_offset: 0, block_length: r.file_size }] }],
		'Cloud.ClientCommitFileUpload#1': () => ['CCloud_ClientCommitFileUpload_Response', { file_committed: true }],
		// classic messages leave the header result empty, which decodes as 2 (Fail): the body's counts
		ClientUCMAddScreenshot: (r) => ['CMsgClientUCMAddScreenshotResponse', { eresult: ucm(r), screenshotid: '123' }, { proto: { eresult: 2 } }],
		'StoreBrowse.GetItems#1': () => ['CStoreBrowse_GetItems_Response', { store_items: [{ appid: 200, id: 200, success: 1, name: 'Some Playtest' }] }],
	}, REQ);
}

function makeTool(client, state = {}) {
	const ctx = toolCtx({ client, state: { baselineAt: Date.now() - 3_600_000, ...state }, config: { when: 'afterClose', privacy: 'private', steamDir: '' },
		gameName: (a) => ({ 100: 'Alpha', 200: 'Bravo', 300: 'Charlie' }[a] || `App ${a}`) });
	const tool = screenshots.create(ctx);
	return { tool, ctx };
}
const names = (client, kind) => client.calls.filter((c) => c.name === kind).map((c) => c.req);

test('jpegSize reads the size from the JPEG header', () => {
	assert.deepStrictEqual(jpegSize(jpeg(2560, 1440)), { width: 2560, height: 1440 });
	assert.strictEqual(jpegSize(Buffer.from('not a jpeg')), null);
	assert.strictEqual(PRIVACY.private, 2);
});

test('waits while the game runs, uploads once it closes, as private', async (t) => {
	const home = tempHome(t);
	writeShot(home, 100, '20261101100000_1.jpg');
	setRunningApp(home, 100);
	const storage = await storageServer(t);
	const client = steam(storage);
	const { tool, ctx } = makeTool(client);
	t.after(() => tool.on.stop());
	await tool.routes['POST settings']({});
	await wait(200);
	assert.strictEqual(names(client, 'ClientUCMAddScreenshot').length, 0, 'nothing while the game runs');
	assert.strictEqual(tool.snapshot().waiting, 1);
	setRunningApp(home, 0);
	await tool.routes['POST settings']({});
	await until(() => ctx.state.uploaded['100/20261101100000_1.jpg']);
	const add = names(client, 'ClientUCMAddScreenshot')[0];
	assert.strictEqual(add.permissions, 2, 'private');
	assert.strictEqual(add.appid, 100);
	assert.strictEqual(add.filename, '100/screenshots/20261101100000_1.jpg');
	assert.strictEqual(names(client, 'Cloud.ClientBeginFileUpload#1')[0].appid, 760, 'Steam Cloud app 760');
	assert.strictEqual(storage.puts.length, 2, 'image + thumbnail');
	assert.ok(ctx.logs.some((l) => /Uploaded 1 Alpha screenshot/.test(l)));
});

test('"already in your library" (DuplicateRequest) counts as done, not as an error', async (t) => {
	const home = tempHome(t);
	writeShot(home, 100, '20261101100000_1.jpg');
	setRunningApp(home, 0);
	const storage = await storageServer(t);
	const { tool, ctx } = makeTool(steam(storage, { ucm: () => 29 }));
	t.after(() => tool.on.stop());
	await tool.routes['POST upload-now']();
	await until(() => ctx.state.uploaded['100/20261101100000_1.jpg']);
	assert.strictEqual(ctx.state.uploaded['100/20261101100000_1.jpg'].existed, true);
	assert.deepStrictEqual(ctx.state.failed, {});
});

test('files already in Steam Cloud with the same content are not sent again', async (t) => {
	const home = tempHome(t);
	const same = jpeg(1920, 1080, 'same');
	writeShot(home, 100, '20261101100000_1.jpg', { data: same });
	writeShot(home, 100, '20261101100001_1.jpg', { data: jpeg(1920, 1080, 'edited') });
	setRunningApp(home, 0);
	const storage = await storageServer(t);
	const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
	const client = steam(storage, { cloudFiles: [
		{ filename: '100/screenshots/20261101100000_1.jpg', file_sha: sha(same) },
		{ filename: '100/screenshots/20261101100001_1.jpg', file_sha: sha(Buffer.from('older version')) },
	] });
	const { tool, ctx } = makeTool(client);
	t.after(() => tool.on.stop());
	await tool.routes['POST upload-now']();
	await until(() => Object.keys(ctx.state.uploaded).length === 2);
	const sent = names(client, 'Cloud.ClientBeginFileUpload#1').map((r) => r.filename);
	assert.ok(!sent.includes('100/screenshots/20261101100000_1.jpg'), 'same content: not sent');
	assert.ok(sent.includes('100/screenshots/20261101100001_1.jpg'), 'changed content: sent');
});

test('a game Steam refuses (AccessDenied) is skipped, including later screenshots', async (t) => {
	const home = tempHome(t);
	for (const n of ['20261102100000_1.jpg', '20261102100001_1.jpg', '20261102100002_1.jpg']) writeShot(home, 200, n);
	setRunningApp(home, 0);
	const storage = await storageServer(t);
	const client = steam(storage, { ucm: () => 15 });
	const { tool, ctx } = makeTool(client);
	t.after(() => tool.on.stop());
	await tool.routes['POST upload-now']();
	await until(() => ctx.state.deniedApps[200]);
	await wait(100);
	assert.strictEqual(names(client, 'ClientUCMAddScreenshot').length, 1, 'asked once, not for every screenshot');
	assert.strictEqual(tool.snapshot().failed.length, 3);
	assert.strictEqual(tool.snapshot().denied[0].game, 'Bravo');
	client.calls.length = 0;
	writeShot(home, 200, '20261103100000_1.jpg');
	await tool.routes['POST upload-now']();
	await wait(300);
	assert.strictEqual(names(client, 'Cloud.ClientBeginFileUpload#1').length, 0, 'nothing sent for the refused game');
	assert.strictEqual(tool.routes['GET queue']({}).upcoming.every((x) => x.state === 'refused'), true);
	tool.routes['POST retry-failed']();
	assert.deepStrictEqual(ctx.state.deniedApps, {});
});

test('uploads game by game, oldest to newest, by the time in the file name', async (t) => {
	const home = tempHome(t);
	// file times scrambled on purpose: the name says when it was taken
	for (const [app, n] of [[200, '20261101100000_1.jpg'], [100, '20261103090000_1.jpg'], [100, '20261102120000_1.jpg'], [200, '20261104080000_1.jpg'], [100, '20261102120000_2.jpg'], [300, '20261105000000_1.jpg']]) {
		writeShot(home, app, n, { minutesAgo: 1 + Math.random() * 30 });
	}
	setRunningApp(home, 0);
	const storage = await storageServer(t);
	const client = steam(storage);
	const { tool, ctx } = makeTool(client);
	t.after(() => tool.on.stop());
	await tool.routes['POST upload-now']();
	await until(() => Object.keys(ctx.state.uploaded).length === 6);
	const order = names(client, 'ClientUCMAddScreenshot').map((r) => `${r.appid}:${r.filename.split('/').pop()}`);
	assert.deepStrictEqual(order, [
		'200:20261101100000_1.jpg', '200:20261104080000_1.jpg',
		'100:20261102120000_1.jpg', '100:20261102120000_2.jpg', '100:20261103090000_1.jpg',
		'300:20261105000000_1.jpg',
	]);
});

test('"Find screenshots missing from Steam" marks what is in Steam Cloud and lists the rest', async (t) => {
	const home = tempHome(t);
	writeShot(home, 100, '20261101100000_1.jpg', { minutesAgo: 14_400 });
	writeShot(home, 100, '20261102100000_1.jpg', { minutesAgo: 14_000 });
	writeShot(home, 300, '20261104100000_1.jpg', { minutesAgo: 13_000 });
	setRunningApp(home, 100);
	const storage = await storageServer(t);
	const client = steam(storage, { cloudFiles: [{ filename: '100/screenshots/20261101100000_1.jpg', file_sha: 'aa' }] });
	const { tool, ctx } = makeTool(client);
	t.after(() => tool.on.stop());
	const r = await tool.routes['POST check-steam']();
	assert.strictEqual(r.found, 1);
	assert.strictEqual(r.missing, 2);
	assert.ok(ctx.state.uploaded['100/20261101100000_1.jpg'].foundInCloud);
	const older = r.games.flatMap((g) => g.older);
	const q = await tool.routes['POST upload-older']({ keys: [...older, '100/20261101100000_1.jpg', 'nope/x.jpg'] });
	assert.strictEqual(q.queued, 2, 'only the missing ones');
});

test('images are only served from the screenshots folder', async (t) => {
	const home = tempHome(t);
	writeShot(home, 100, '20261101100000_1.jpg');
	fs.writeFileSync(path.join(home, 'secret.jpg'), 'SECRET');
	const { tool } = makeTool(steam(await storageServer(t)));
	t.after(() => tool.on.stop());
	await tool.routes['POST check-steam']().catch(() => {});
	const ok = await tool.routes['GET image']({ key: '100/20261101100000_1.jpg' });
	assert.ok(ok.body.length > 0);
	for (const key of ['../../../../secret.jpg', '100/../../../../../../secret.jpg']) {
		await assert.rejects(() => tool.routes['GET image']({ key }), /Bad screenshot/);
	}
});
