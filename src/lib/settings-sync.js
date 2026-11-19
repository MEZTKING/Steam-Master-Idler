'use strict';

// Backs up the app's settings (config.json + state.json: tool settings, ratings, upload history,
// launch option configs, stats, ...) as one JSON file into a folder, normally the one your Google
// Drive / OneDrive / Dropbox / iCloud app syncs, so another device can restore it. The Steam sign-in
// and password are never included: a new device signs in itself.

const fs = require('fs');
const os = require('os');
const path = require('path');

const SUBFOLDER = 'Kettle';
const PREFIX = 'kettle-';
// from before the app was renamed: still listed and restorable
const OLD_SUBFOLDER = 'Steam Master Idler';
const OLD_PREFIX = 'steam-master-idler-';
const APP_IDS = ['kettle', 'steam-master-idler'];
const KEEP_PER_DEVICE = 20;
// state that belongs to this install only
const LOCAL_STATE = ['logonID', 'resume'];

const exists = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Folders on this computer that a cloud app keeps in sync
function detectCloudFolders() {
	const home = os.homedir();
	const env = process.env;
	const out = [];
	const add = (name, p) => { if (p && exists(p) && !out.some((x) => path.resolve(x.path) === path.resolve(p))) out.push({ name, path: p }); };
	// Google Drive for desktop: a drive letter with "My Drive" (Windows), CloudStorage (macOS), older folders
	if (process.platform === 'win32') for (const l of 'GHIJKLMNOPQRSTUVWXYZDEF') add('Google Drive', `${l}:\\My Drive`);
	try { for (const d of fs.readdirSync(path.join(home, 'Library', 'CloudStorage'))) { if (d.startsWith('GoogleDrive-')) add('Google Drive', path.join(home, 'Library', 'CloudStorage', d, 'My Drive')); if (d.startsWith('OneDrive')) add('OneDrive', path.join(home, 'Library', 'CloudStorage', d)); if (d.startsWith('Dropbox')) add('Dropbox', path.join(home, 'Library', 'CloudStorage', d)); } } catch { /* not macOS */ }
	add('Google Drive', path.join(home, 'Google Drive', 'My Drive'));
	add('Google Drive', path.join(home, 'Google Drive'));
	add('Google Drive', path.join(home, 'My Drive'));
	// OneDrive
	add('OneDrive', env.OneDrive); add('OneDrive', env.OneDriveConsumer); add('OneDrive', path.join(home, 'OneDrive'));
	// Dropbox: its info.json says where the folder is
	for (const f of [env.APPDATA && path.join(env.APPDATA, 'Dropbox', 'info.json'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Dropbox', 'info.json'), path.join(home, '.dropbox', 'info.json')]) {
		const j = f && readJson(f);
		if (j) for (const v of Object.values(j)) add('Dropbox', v?.path);
	}
	add('Dropbox', path.join(home, 'Dropbox'));
	// iCloud Drive
	add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
	add('iCloud Drive', path.join(home, 'iCloudDrive'));
	return out;
}

const backupDir = (folder) => path.join(folder, SUBFOLDER);
const deviceName = () => os.hostname().replace(/[^\w.-]+/g, '-').slice(0, 40) || 'device';

function makeBackup({ config, state, version }) {
	const cfg = { ...config };
	delete cfg.password;
	const st = { ...state };
	for (const k of LOCAL_STATE) delete st[k];
	return { app: 'kettle', format: 1, version, createdAt: new Date().toISOString(), device: os.hostname(), platform: process.platform, config: cfg, state: st };
}

function validate(b) {
	if (!b || !APP_IDS.includes(b.app) || b.format !== 1 || typeof b.config !== 'object' || typeof b.state !== 'object') throw new Error("That isn't a Kettle settings backup.");
	return b;
}

// write a backup into <folder>/Kettle/, keep the newest per device
function writeBackup(folder, backup) {
	const dir = backupDir(folder);
	fs.mkdirSync(dir, { recursive: true });
	const stamp = backup.createdAt.replace(/[:.]/g, '-').slice(0, 19);
	const name = `${PREFIX}${deviceName()}-${stamp}.json`;
	const tmp = path.join(dir, `.${name}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(backup));
	fs.renameSync(tmp, path.join(dir, name));
	const mine = fs.readdirSync(dir).filter((f) => f.startsWith(`${PREFIX}${deviceName()}-`) && f.endsWith('.json')).sort();
	for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_PER_DEVICE))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
	return name;
}

// backups in the folder (from every device, and from before the rename), newest first.
// file is "Kettle/<name>" or "Steam Master Idler/<name>"
function listBackups(folder) {
	const out = [];
	for (const [sub, prefix] of [[SUBFOLDER, PREFIX], [OLD_SUBFOLDER, OLD_PREFIX]]) {
		const dir = path.join(folder, sub);
		let files = [];
		try { files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')); } catch { continue; }
		for (const f of files) {
			const b = readJson(path.join(dir, f));
			if (!b || !APP_IDS.includes(b.app)) continue;
			const tools = Object.entries(b.config?.tools || {}).filter(([, c]) => c?.enabled).map(([id]) => id);
			out.push({ file: `${sub}/${f}`, createdAt: b.createdAt, device: b.device, platform: b.platform, version: b.version, size: fs.statSync(path.join(dir, f)).size, tools, thisDevice: b.device === os.hostname() });
		}
	}
	return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function readBackup(folder, file) {
	const [sub, name] = String(file).includes('/') ? String(file).split('/') : [SUBFOLDER, String(file)];
	const ok = (sub === SUBFOLDER && name.startsWith(PREFIX)) || (sub === OLD_SUBFOLDER && name.startsWith(OLD_PREFIX));
	if (!ok || !/^[\w.-]+\.json$/.test(name)) throw new Error('Bad backup name');
	return validate(readJson(path.join(folder, sub, name)));
}

// the config + state to put in place on this device (keeping what belongs to this install)
function restoreInto({ backup, config, state }) {
	validate(backup);
	const cfg = { ...backup.config, password: config.password || '' };
	const st = { ...backup.state };
	for (const k of LOCAL_STATE) if (state[k] !== undefined) st[k] = state[k];
	// backups were made on another computer: its sync folder stays this one's
	cfg.syncFolder = config.syncFolder;
	return { config: cfg, state: st };
}

module.exports = { detectCloudFolders, makeBackup, writeBackup, listBackups, readBackup, restoreInto, validate, backupDir, deviceName };
