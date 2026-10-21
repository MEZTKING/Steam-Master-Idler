'use strict';

// "Idle through the Steam app": one helper process per game (see helper.js), so the Steam app on this
// PC shows the games as running and you can still launch other games normally. Windows only for now.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

// IDLER_STEAMCLIENT_LIB: full path to steamclient64.dll, for Steam installed somewhere unusual
const LIB_OVERRIDE = process.env.IDLER_STEAMCLIENT_LIB || null;
const SUPPORTED = process.platform === 'win32' || !!LIB_OVERRIDE;

// helper.js has to run from a real folder (not inside the packed app.asar) so koffi can load
const HELPER = path.join(__dirname, 'helper.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function findSteamClientLib() {
	if (LIB_OVERRIDE) return fs.existsSync(LIB_OVERRIDE) ? LIB_OVERRIDE : null;
	if (!SUPPORTED) return null;
	const dirs = [];
	try {
		const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true });
		const m = out.match(/SteamPath\s+REG_SZ\s+(.+)/);
		if (m) dirs.push(m[1].trim().replace(/\//g, '\\'));
	} catch { /* not in the registry */ }
	dirs.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
	const file = process.arch === 'ia32' ? 'steamclient.dll' : 'steamclient64.dll';
	for (const dir of dirs) {
		const p = path.join(dir, file);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

class SteamAppIdler extends EventEmitter {
	// events: 'ready' (appid, via), 'error' (appid, message), 'debug' (message)
	constructor() {
		super();
		this.children = new Map();   // appid -> { proc, state: 'starting'|'running'|'failed', error }
		this.lib = null;
	}

	available() {
		if (!SUPPORTED) return { ok: false, reason: 'Idling through the Steam app works on Windows only for now.' };
		if (!this.lib && Date.now() - (this.lastLookup || 0) > 60_000) {   // the registry lookup isn't free
			this.lastLookup = Date.now();
			this.lib = findSteamClientLib();
		}
		if (!this.lib) return { ok: false, reason: "Couldn't find the Steam app (steamclient64.dll). Is Steam installed?" };
		return { ok: true, lib: this.lib };
	}

	// make exactly these games run
	set(appids) {
		const want = new Set(appids.map(Number));
		for (const [appid] of this.children) if (!want.has(appid)) this.stop(appid);
		for (const appid of want) if (!this.children.has(appid)) this.start(appid);
	}

	start(appid) {
		const avail = this.available();
		if (!avail.ok) {
			this.children.set(appid, { proc: null, state: 'failed', error: avail.reason });
			this.emit('error', appid, avail.reason);
			return;
		}
		const proc = spawn(process.execPath, [HELPER, avail.lib, String(appid)], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SteamAppId: String(appid), SteamGameId: String(appid) },
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			windowsHide: true,
		});
		const entry = { proc, state: 'starting', error: null };
		this.children.set(appid, entry);
		this.emit('debug', `helper started for ${appid} (pid ${proc.pid}) using ${avail.lib}`);
		proc.on('message', (msg) => {
			if (msg?.type === 'ready') { entry.state = 'running'; this.emit('ready', appid, msg.via); }
			if (msg?.type === 'error') { entry.state = 'failed'; entry.error = msg.message; this.emit('error', appid, msg.message); }
		});
		proc.on('error', (err) => {   // spawn failures, IPC errors - never let them crash the app
			this.emit('debug', `helper ${appid} error: ${err.message}`);
			if (entry.state !== 'failed' && this.children.get(appid) === entry) {
				entry.state = 'failed';
				entry.error = err.message;
				this.emit('error', appid, err.message);
			}
		});
		const out = (d) => this.emit('debug', `helper ${appid}: ${String(d).trim()}`);
		proc.stdout.on('data', out);
		proc.stderr.on('data', out);
		proc.on('exit', (code) => {
			this.emit('debug', `helper for ${appid} exited with code ${code}`);
			if (this.children.get(appid) !== entry) return;   // stopped on purpose
			if (entry.state !== 'failed') {
				entry.state = 'failed';
				entry.error = `stopped unexpectedly (code ${code})`;
				this.emit('error', appid, entry.error);
			}
		});
	}

	stop(appid) {
		const entry = this.children.get(appid);
		this.children.delete(appid);
		if (entry?.proc && entry.proc.exitCode == null) {
			try { entry.proc.disconnect(); } catch {}
			setTimeout(() => { if (entry.proc.exitCode == null) entry.proc.kill(); }, 3000);
		}
	}

	stopAll() {
		for (const appid of [...this.children.keys()]) this.stop(appid);
	}

	// forget failed helpers so the next set() retries them
	retryFailed() {
		for (const [appid, entry] of this.children) if (entry.state === 'failed') this.children.delete(appid);
	}

	status() {
		return Object.fromEntries([...this.children].map(([appid, e]) => [appid, { state: e.state, error: e.error }]));
	}
}

module.exports = { SteamAppIdler, SUPPORTED };
