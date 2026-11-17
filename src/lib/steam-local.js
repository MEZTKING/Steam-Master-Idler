'use strict';

// Finds things the Steam app keeps on this computer: its install folder, your userdata folder
// (screenshots live in userdata/<account id>/760/remote/<appid>/screenshots), and which game the
// Steam app is running right now.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { parseVdf, vdfGet } = require('./vdf');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function regQuery(key, value) {
	return new Promise((resolve) => {
		execFile('reg', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, out) => {
			if (err) return resolve(null);
			const m = String(out).match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i'));
			resolve(m ? m[1].trim() : null);
		});
	});
}

// Candidate Steam install folders for this OS, most likely first
async function steamDirCandidates() {
	const home = os.homedir();
	const dirs = [];
	if (process.platform === 'win32') {
		const reg = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
		if (reg) dirs.push(reg.replace(/\//g, '\\'));
		dirs.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
	} else if (process.platform === 'darwin') {
		dirs.push(path.join(home, 'Library', 'Application Support', 'Steam'));
	} else {
		dirs.push(
			path.join(home, '.steam', 'steam'),
			path.join(home, '.local', 'share', 'Steam'),
			path.join(home, '.steam', 'root'),
			path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),   // Flatpak
			path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
		);
	}
	return [...new Set(dirs)];
}

// The Steam folder that has a userdata folder (optionally for this account id)
async function findSteamDir(override, accountId) {
	const list = override ? [override] : await steamDirCandidates();
	const withUserdata = list.filter((d) => isDir(path.join(d, 'userdata')));
	if (accountId != null) {
		const mine = withUserdata.find((d) => isDir(path.join(d, 'userdata', String(accountId))));
		if (mine) return mine;
	}
	return withUserdata[0] || null;
}

// The folder Steam keeps your screenshots in: <steam>/userdata/<account id>/760
const screenshotsRoot = (steamDir, accountId) => path.join(steamDir, 'userdata', String(accountId), '760');

// App ID of the game the Steam app is running (0 = none, null = can't tell on this system)
async function runningAppId(steamDir) {
	if (process.platform === 'win32') {
		const v = await regQuery('HKCU\\Software\\Valve\\Steam', 'RunningAppID');
		return v == null ? null : parseInt(v, v.startsWith('0x') ? 16 : 10) || 0;
	}
	const files = [path.join(os.homedir(), '.steam', 'registry.vdf')];
	if (steamDir) files.push(path.join(steamDir, 'registry.vdf'));
	for (const f of files) {
		try {
			const reg = parseVdf(fs.readFileSync(f, 'utf8'));
			const v = vdfGet(reg, 'Registry', 'HKCU', 'Software', 'Valve', 'Steam', 'RunningAppID');
			if (v != null) return parseInt(v, 10) || 0;
		} catch { /* not here */ }
	}
	return null;
}

module.exports = { findSteamDir, steamDirCandidates, screenshotsRoot, runningAppId };
