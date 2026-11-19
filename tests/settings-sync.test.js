'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('../src/lib/settings-sync');

function folder(t) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-drive-'));
	t.after(() => fs.rmSync(d, { recursive: true, force: true }));
	return d;
}

test('a backup has the settings, never the password or this install\'s ID', () => {
	const b = sync.makeBackup({ config: { theme: 'light', password: 'hunter2', tools: { gallery: { enabled: true } } }, state: { logonID: 5, resume: {}, stats: { cards: 3 } }, version: '1.12.0' });
	assert.strictEqual(b.app, 'kettle');
	assert.strictEqual(b.config.theme, 'light');
	assert.ok(!('password' in b.config));
	assert.ok(!('logonID' in b.state) && !('resume' in b.state));
	assert.strictEqual(b.state.stats.cards, 3);
});

test('write, list (new and old-name backups), read', (t) => {
	const f = folder(t);
	fs.mkdirSync(path.join(f, 'Steam Master Idler'));
	fs.writeFileSync(path.join(f, 'Steam Master Idler', 'steam-master-idler-LAPTOP-2026-11-17T10-00-00.json'),
		JSON.stringify({ app: 'steam-master-idler', format: 1, version: '1.10.0', createdAt: '2026-11-17T10:00:00Z', device: 'LAPTOP', config: { tools: {} }, state: {} }));
	sync.writeBackup(f, sync.makeBackup({ config: { tools: { gallery: { enabled: true } } }, state: {}, version: '1.12.0' }));
	const list = sync.listBackups(f);
	assert.strictEqual(list.length, 2);
	assert.match(list[0].file, /^Kettle\/kettle-/);
	assert.deepStrictEqual(list[0].tools, ['gallery']);
	assert.strictEqual(list[1].device, 'LAPTOP');
	assert.strictEqual(sync.readBackup(f, list[1].file).app, 'steam-master-idler');
	for (const bad of ['../x/kettle-a.json', 'Kettle/steam-master-idler-x.json', 'Other/kettle-a.json', 'Kettle/kettle-../../x.json']) {
		assert.throws(() => sync.readBackup(f, bad), /Bad backup name/, bad);
	}
});

test('keeps only the newest backups per device', (t) => {
	const f = folder(t);
	for (let i = 0; i < 25; i++) {
		const b = sync.makeBackup({ config: {}, state: {}, version: '1' });
		b.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
		sync.writeBackup(f, b);
	}
	assert.strictEqual(sync.listBackups(f).length, 20);
});

test('restoring keeps this device\'s ID, password and sync folder', () => {
	const backup = sync.makeBackup({ config: { theme: 'light', syncFolder: 'X:\\Other' }, state: { stats: { cards: 9 }, logonID: 1 }, version: '1' });
	const r = sync.restoreInto({ backup, config: { password: 'p', syncFolder: 'G:\\My Drive' }, state: { logonID: 42 } });
	assert.strictEqual(r.config.theme, 'light');
	assert.strictEqual(r.config.password, 'p');
	assert.strictEqual(r.config.syncFolder, 'G:\\My Drive');
	assert.strictEqual(r.state.logonID, 42);
	assert.strictEqual(r.state.stats.cards, 9);
	assert.throws(() => sync.validate({ hello: 1 }), /isn't a Kettle settings backup/);
});
