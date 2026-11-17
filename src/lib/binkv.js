'use strict';

// Reader for Valve's binary KeyValues (used for game stat/achievement schemas).
const T = { NONE: 0, STRING: 1, INT32: 2, FLOAT32: 3, POINTER: 4, WSTRING: 5, COLOR: 6, UINT64: 7, END: 8, INT64: 10, END2: 11 };

function parseBinaryKv(buf) {
	let i = 0;
	const cstr = () => { const end = buf.indexOf(0, i); const s = buf.toString('utf8', i, end < 0 ? buf.length : end); i = end < 0 ? buf.length : end + 1; return s; };
	function obj() {
		const out = {};
		while (i < buf.length) {
			const type = buf[i++];
			if (type === T.END || type === T.END2) break;
			const key = cstr();
			switch (type) {
				case T.NONE: out[key] = obj(); break;
				case T.STRING: out[key] = cstr(); break;
				case T.INT32: case T.COLOR: case T.POINTER: out[key] = buf.readInt32LE(i); i += 4; break;
				case T.FLOAT32: out[key] = buf.readFloatLE(i); i += 4; break;
				case T.UINT64: out[key] = buf.readBigUInt64LE(i).toString(); i += 8; break;
				case T.INT64: out[key] = buf.readBigInt64LE(i).toString(); i += 8; break;
				case T.WSTRING: { const end = i; let j = end; while (j + 1 < buf.length && (buf[j] || buf[j + 1])) j += 2; out[key] = buf.toString('utf16le', i, j); i = j + 2; break; }
				default: throw new Error(`Unknown KeyValues type ${type}`);
			}
		}
		return out;
	}
	return obj();
}

module.exports = { parseBinaryKv };
