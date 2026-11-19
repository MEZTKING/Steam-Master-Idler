'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tempHome, steamUserdata, screenshotsDir, writeShot, fakeClient, toolCtx, jpeg } = require('./helpers');
const gallery = require('../src/tools/gallery');

function setup(t) {
	const home = tempHome(t);
	writeShot(home, 10, '20261101100000_1.jpg');
	writeShot(home, 10, '20261102100000_1.jpg', { thumb: false });
	writeShot(home, 20, '20261103100000_1.jpg');
	writeShot(home, 20, '20261104100000_1.jpg');
	fs.writeFileSync(path.join(steamUserdata(home), '760', 'screenshots.vdf'), '"Screenshots"{"20"{"0"{"filename" "20/screenshots/20261103100000_1.jpg" "publishedfileid" "555" "hscreenshot" "777"}}}');
	fs.writeFileSync(path.join(home, 'secret.jpg'), 'SECRET');
	const calls = [];
	const client = fakeClient({ ClientUCMDeleteScreenshot: (r) => { calls.push(r.screenshotid); return ['CMsgClientUCMDeleteScreenshotResponse', { eresult: 1 }, { proto: { eresult: 2 } }]; } },
		{ ClientUCMDeleteScreenshot: 'CMsgClientUCMDeleteScreenshot' });
	const uploads = [];
	const ctx = toolCtx({ client, config: { autoBackup: 'liked', folder: '' }, gameName: (a) => ({ 10: 'Alpha: The Game', 20: 'Bravo' }[a]),
		toolState: (id) => (id === 'screenshots' ? { uploaded: { '10/20261101100000_1.jpg': { id: '999' } } } : {}),
		callTool: async (id, m, action, body) => { uploads.push([id, action, body.keys]); return { queued: body.keys.length }; } });
	const tool = gallery.create(ctx);
	t.after(() => tool.on.stop());
	return { home, tool, ctx, calls, uploads, backups: path.join(home, 'data', 'screenshot-backups') };
}

test('lists every screenshot with what Steam knows about it', async (t) => {
	const { tool } = setup(t);
	const { shots, games } = await tool.routes['GET list']();
	assert.strictEqual(shots.length, 4);
	assert.strictEqual(games[10], 'Alpha: The Game');
	const by = Object.fromEntries(shots.map((s) => [s.key, s]));
	assert.strictEqual(by['10/20261101100000_1.jpg'].steamId, '999', 'uploaded by Kettle');
	assert.strictEqual(by['20/20261103100000_1.jpg'].steamId, '777', 'uploaded in the Steam app (screenshots.vdf)');
	assert.strictEqual(by['20/20261104100000_1.jpg'].onSteam, false);
});

test('rate, back up the liked ones once, per game folder', async (t) => {
	const { tool, backups } = setup(t);
	tool.routes['POST rate']({ keys: ['10/20261101100000_1.jpg', '20/20261103100000_1.jpg'], rating: 1 });
	tool.routes['POST rate']({ keys: ['20/20261104100000_1.jpg'], rating: -1 });
	assert.deepStrictEqual(await tool.routes['POST backup']({}), { copied: 2 });
	assert.deepStrictEqual(await tool.routes['POST backup']({}), { copied: 0 }, 'not copied twice');
	assert.ok(fs.existsSync(path.join(backups, 'Alpha_ The Game', '20261101100000_1.jpg')), 'unsafe characters replaced');
	assert.ok(fs.existsSync(path.join(backups, 'Bravo', '20261103100000_1.jpg')));
});

test('trash is restorable; emptying it is the only delete', async (t) => {
	const { home, tool, backups } = setup(t);
	const key = '20/20261104100000_1.jpg';
	const src = path.join(screenshotsDir(home, 20), '20261104100000_1.jpg');
	await tool.routes['POST trash']({ keys: [key] });
	assert.ok(!fs.existsSync(src));
	assert.ok(fs.existsSync(path.join(backups, '.trash', '20', 'thumbnails', '20261104100000_1.jpg')), 'thumbnail goes along');
	assert.strictEqual((await tool.routes['GET image']({ key })).body.length > 0, true, 'trash images still show');
	await tool.routes['POST restore']({ keys: [key] });
	assert.ok(fs.existsSync(src) && fs.existsSync(path.join(screenshotsDir(home, 20), 'thumbnails', '20261104100000_1.jpg')));
	await tool.routes['POST trash']({ keys: [key] });
	assert.deepStrictEqual(await tool.routes['POST empty-trash']({}), { deleted: 1 });
	assert.ok(!fs.existsSync(path.join(backups, '.trash', '20', '20261104100000_1.jpg')));
});

test('images: thumbnail, full size, and nothing outside the folders', async (t) => {
	const { tool } = setup(t);
	assert.ok((await tool.routes['GET image']({ key: '10/20261101100000_1.jpg' })).body.length < 60, 'thumbnail');
	assert.ok((await tool.routes['GET image']({ key: '10/20261102100000_1.jpg' })).body.length > 0, 'no thumbnail: the image');
	for (const key of ['../../../../secret.jpg', '10/../../../../../../secret.jpg', '10/x.png']) {
		await assert.rejects(() => tool.routes['GET image']({ key }), /Bad screenshot/, key);
	}
});

test('upload goes through the uploader; remove-from-Steam uses the known ids', async (t) => {
	const { tool, calls, uploads } = setup(t);
	await tool.routes['POST upload']({ keys: ['10/20261102100000_1.jpg', 'bad key'] });
	assert.deepStrictEqual(uploads, [['screenshots', 'upload-older', ['10/20261102100000_1.jpg']]]);
	const r = await tool.routes['POST remove-from-steam']({ keys: ['10/20261101100000_1.jpg', '20/20261103100000_1.jpg', '10/20261102100000_1.jpg'] });
	assert.strictEqual(r.removed, 2);
	assert.deepStrictEqual(calls, ['999', '777']);
});

test('import: a JPEG becomes a Steam-named screenshot of the game, within Steam\'s limits', async (t) => {
	const { home, tool } = setup(t);
	const takenAt = new Date(2026, 0, 2, 3, 4, 5).getTime();
	const r = await tool.routes['POST import']({ appid: 30, takenAt, image: jpeg(2560, 1440, 'x').toString('base64'), thumb: jpeg(200, 113, 't').toString('base64') });
	assert.strictEqual(r.name, '20260102030405_1.jpg');
	const r2 = await tool.routes['POST import']({ appid: 30, takenAt, image: jpeg(2560, 1440, 'y').toString('base64') });
	assert.strictEqual(r2.name, '20260102030405_2.jpg', 'same second: _2');
	assert.ok(fs.existsSync(path.join(screenshotsDir(home, 30), 'thumbnails', '20260102030405_1.jpg')));
	await assert.rejects(() => tool.routes['POST import']({ appid: 30, image: Buffer.from('png').toString('base64') }), /converted to JPEG/);
	await assert.rejects(() => tool.routes['POST import']({ appid: 30, image: jpeg(17000, 100).toString('base64') }), /bigger than Steam accepts/);
	const info = await tool.routes['GET import-info']({ appid: '30' });
	assert.deepStrictEqual([info.common.width, info.common.height], [2560, 1440], '"same as my screenshots" size');
});
