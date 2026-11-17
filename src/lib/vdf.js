'use strict';

// Minimal reader for Valve's text KeyValues format (screenshots.vdf, registry.vdf, libraryfolders.vdf).
// Returns nested plain objects; keys keep their original case. Comments and #include lines are skipped.

function parseVdf(text) {
	const root = {};
	const stack = [root];
	let i = 0;
	const n = text.length;
	let pendingKey = null;

	function readString() {
		if (text[i] === '"') {
			i++;
			let out = '';
			while (i < n && text[i] !== '"') {
				if (text[i] === '\\' && i + 1 < n) {
					const c = text[i + 1];
					out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
					i += 2;
				} else {
					out += text[i++];
				}
			}
			i++;   // closing quote
			return out;
		}
		const start = i;
		while (i < n && !/[\s{}"]/.test(text[i])) i++;
		return text.slice(start, i);
	}

	while (i < n) {
		const c = text[i];
		if (/\s/.test(c)) { i++; continue; }
		if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
		if (c === '#' && pendingKey == null) { while (i < n && text[i] !== '\n') i++; continue; }
		if (c === '[') { while (i < n && text[i] !== ']') i++; i++; continue; }   // [$WIN32] conditionals
		if (c === '{') {
			i++;
			const obj = {};
			stack[stack.length - 1][pendingKey ?? ''] = obj;
			stack.push(obj);
			pendingKey = null;
			continue;
		}
		if (c === '}') {
			i++;
			if (stack.length > 1) stack.pop();
			pendingKey = null;
			continue;
		}
		const s = readString();
		if (pendingKey == null) pendingKey = s;
		else { stack[stack.length - 1][pendingKey] = s; pendingKey = null; }
	}
	return root;
}

// case-insensitive lookup along a path: get(obj, 'Registry', 'HKCU', 'Software')
function vdfGet(obj, ...keys) {
	let cur = obj;
	for (const k of keys) {
		if (!cur || typeof cur !== 'object') return undefined;
		const hit = Object.keys(cur).find((x) => x.toLowerCase() === String(k).toLowerCase());
		cur = hit === undefined ? undefined : cur[hit];
	}
	return cur;
}

module.exports = { parseVdf, vdfGet };
