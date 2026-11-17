'use strict';

// Persistent debug log (logs/debug.log in the data folder) for bug reports, plus the last few
// thousand entries in memory for the in-app Developer view.
// Everything is scrubbed of tokens, cookies and keys before it is written or kept.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // then rotate to debug.old.log
const MEMORY = 3000;                 // entries kept for the Developer view

function redact(text) {
	return String(text)
		.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[jwt]')                     // access / refresh tokens
		.replace(/(steamLoginSecure|sessionid|steamRefresh_steam|clientsessionid)=[^;\s"]+/gi, '$1=[redacted]')
		.replace(/(token|key|secret|password|ticket)(["'\s:=]+)[^\s"',]{6,}/gi, '$1$2[redacted]')
		.replace(/\b[0-9a-f]{32,}\b/gi, '[hex]')
		.replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, '[blob]');
}

// category -> level shown in the Developer view
const LEVELS = { crash: 'error', error: 'error', warn: 'warn', info: 'info', steam: 'debug', 'steam-verbose': 'trace' };
const levelOf = (cat) => LEVELS[cat] || 'debug';

function createDebugLog(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'debug.log');
	const oldFile = path.join(dir, 'debug.old.log');
	let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
	const ring = [];
	let seq = 0;

	// cat: what it's about (info, steam, api, error, a tool's id, ...); memoryOnly: not written to disk
	function write(cat, ...parts) {
		let memoryOnly = false;
		if (parts[parts.length - 1] === write.MEMORY_ONLY) { parts.pop(); memoryOnly = true; }
		const msg = redact(parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? (p.stack || p.message) : JSON.stringify(p))).join(' '));
		const t = Date.now();
		ring.push({ seq: ++seq, t, cat, level: levelOf(cat), msg: msg.length > 4000 ? `${msg.slice(0, 4000)}… (${msg.length} chars)` : msg });
		if (ring.length > MEMORY) ring.shift();
		if (memoryOnly) return;
		const line = `${new Date(t).toISOString()} [${cat}] ${msg}\n`;
		try {
			if (size + line.length > MAX_BYTES) {
				fs.renameSync(file, oldFile);
				size = 0;
			}
			fs.appendFileSync(file, line);
			size += line.length;
		} catch { /* logging must never break the app */ }
	}
	write.MEMORY_ONLY = Symbol('memory only');

	// entries newer than `after` (for the live view)
	function entries(after = 0, limit = 1000) {
		const out = ring.filter((e) => e.seq > after);
		return { seq, entries: out.slice(-limit), dropped: Math.max(0, out.length - limit) };
	}

	// last `lines` lines across debug.old.log + debug.log
	function tail(lines = 3000) {
		const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
		return (read(oldFile) + read(file)).split('\n').filter(Boolean).slice(-lines).join('\n');
	}

	const fileSize = () => { try { return fs.statSync(file).size + (fs.existsSync(oldFile) ? fs.statSync(oldFile).size : 0); } catch { return 0; } };

	return { write, tail, entries, fileSize, dir };
}

module.exports = { createDebugLog, redact };
