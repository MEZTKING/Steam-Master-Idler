'use strict';

// Persistent debug log (logs/debug.log in the data folder) for bug reports.
// Everything is scrubbed of tokens, cookies and keys before it is written.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // then rotate to debug.old.log

function redact(text) {
	return String(text)
		.replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, '[jwt]')                     // access / refresh tokens
		.replace(/(steamLoginSecure|sessionid|steamRefresh_steam|clientsessionid)=[^;\s"]+/gi, '$1=[redacted]')
		.replace(/(token|key|secret|password|ticket)(["'\s:=]+)[^\s"',]{6,}/gi, '$1$2[redacted]')
		.replace(/\b[0-9a-f]{32,}\b/gi, '[hex]')
		.replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, '[blob]');
}

function createDebugLog(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'debug.log');
	const oldFile = path.join(dir, 'debug.old.log');
	let size = fs.existsSync(file) ? fs.statSync(file).size : 0;

	function write(level, ...parts) {
		const msg = parts.map((p) => (typeof p === 'string' ? p : p instanceof Error ? (p.stack || p.message) : JSON.stringify(p))).join(' ');
		const line = `${new Date().toISOString()} [${level}] ${redact(msg)}\n`;
		try {
			if (size + line.length > MAX_BYTES) {
				fs.renameSync(file, oldFile);
				size = 0;
			}
			fs.appendFileSync(file, line);
			size += line.length;
		} catch { /* logging must never break the app */ }
	}

	// last `lines` lines across debug.old.log + debug.log
	function tail(lines = 3000) {
		const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
		return (read(oldFile) + read(file)).split('\n').filter(Boolean).slice(-lines).join('\n');
	}

	return { write, tail, dir };
}

module.exports = { createDebugLog, redact };
