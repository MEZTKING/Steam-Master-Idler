'use strict';

// Change one value inside a Valve text KeyValues file (e.g. localconfig.vdf) without rewriting the
// rest of it: everything else - order, duplicate keys, comments, spacing - stays byte for byte.
//
//   setVdfValue(text, ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps', '730'], 'LaunchOptions', '-novid')
//   getVdfValue(text, [...path], 'LaunchOptions')
// Keys match without regard to case, like Steam does. Missing blocks along the path are created.

const unescape = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');

function tokenize(text) {
	const out = [];
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (/\s/.test(c)) { i++; continue; }
		if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
		if (c === '{' || c === '}') { out.push({ t: c, start: i, end: i + 1 }); i++; continue; }
		if (c === '[') { while (i < text.length && text[i] !== ']') i++; i++; continue; }   // [$WIN32] conditions
		const start = i;
		if (c === '"') {
			i++;
			while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
			i++;
			out.push({ t: 's', v: unescape(text.slice(start + 1, i - 1)), start, end: i });
		} else {
			while (i < text.length && !/[\s{}"]/.test(text[i])) i++;
			out.push({ t: 's', v: text.slice(start, i), start, end: i });
		}
	}
	return out;
}

// -> { entries: [{ key, keyTok, value: tok | block }], open, close }   (open/close: brace tokens)
function parse(tokens) {
	let p = 0;
	function block(open) {
		const entries = [];
		while (p < tokens.length) {
			const k = tokens[p];
			if (k.t === '}') { p++; return { entries, open, close: k }; }
			p++;
			if (k.t !== 's') continue;
			const v = tokens[p];
			if (!v) break;
			if (v.t === '{') { p++; entries.push({ key: k.v, keyTok: k, value: block(v) }); } else if (v.t === 's') { p++; entries.push({ key: k.v, keyTok: k, value: v }); }
		}
		return { entries, open, close: null };
	}
	return block(null);
}

const find = (blk, key) => blk.entries.find((e) => e.key.toLowerCase() === String(key).toLowerCase());
const indentAt = (text, pos) => { const ls = text.lastIndexOf('\n', pos - 1) + 1; return text.slice(ls, pos).match(/^[ \t]*/)[0]; };

function getVdfValue(text, path, key) {
	let blk = parse(tokenize(text));
	for (const k of path) { const e = find(blk, k); if (!e || !e.value.entries) return undefined; blk = e.value; }
	const e = find(blk, key);
	return e && !e.value.entries ? e.value.v : undefined;
}

// a block's whole contents as { key: string | object } (read-only view)
function getVdfBlock(text, path) {
	let blk = parse(tokenize(text));
	for (const k of path) { const e = find(blk, k); if (!e || !e.value.entries) return undefined; blk = e.value; }
	const toObj = (b) => Object.fromEntries(b.entries.map((e) => [e.key, e.value.entries ? toObj(e.value) : e.value.v]));
	return toObj(blk);
}

function setVdfValue(text, path, key, value) {
	const nl = text.includes('\r\n') ? '\r\n' : '\n';
	const root = parse(tokenize(text));
	let blk = root;
	let depth = 0;
	const missing = [];
	for (const k of path) {
		const e = find(blk, k);
		if (!e || !e.value.entries) { missing.push(...path.slice(depth)); break; }
		blk = e.value;
		depth++;
	}
	if (!missing.length) {
		const e = find(blk, key);
		if (e && !e.value.entries) {   // replace just the value token
			return text.slice(0, e.value.start) + `"${escape(value)}"` + text.slice(e.value.end);
		}
	}
	if (!blk.close) throw new Error('This file is not in the format expected (block not closed)');
	// insert before the closing brace of the deepest existing block: the missing blocks, then the key
	const base = indentAt(text, blk.close.start);
	const inner = base + '\t';
	let ins = '';
	let ind = inner;
	for (const k of missing) { ins += `${ind}"${escape(k)}"${nl}${ind}{${nl}`; ind += '\t'; }
	ins += `${ind}"${escape(key)}"\t\t"${escape(value)}"${nl}`;
	for (let i = missing.length - 1; i >= 0; i--) { ind = ind.slice(0, -1); ins += `${ind}}${nl}`; }
	// put it on its own line, right before the closing brace's indentation
	const lineStart = text.lastIndexOf('\n', blk.close.start - 1) + 1;
	const onOwnLine = /^[ \t]*$/.test(text.slice(lineStart, blk.close.start));
	return onOwnLine ? text.slice(0, lineStart) + ins + text.slice(lineStart) : text.slice(0, blk.close.start) + nl + ins + base + text.slice(blk.close.start);
}

module.exports = { getVdfValue, getVdfBlock, setVdfValue, tokenize };
