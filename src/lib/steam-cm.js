'use strict';

// Raw requests to Steam's client network (CM) over steam-user's connection, for features steam-user
// has no method for (Steam Cloud uploads, screenshots, achievements, store, ...). Uses steam-user's
// own protobuf schema, plus a few message types it doesn't ship (defineTypes).
//
//   await callService(client, 'Cloud.ClientBeginFileUpload#1', 'CCloud_ClientBeginFileUpload_Request',
//                     'CCloud_ClientBeginFileUpload_Response', { appid: 760, ... })
//   await sendMsg(client, EMsg.ClientUCMAddScreenshot, 'CMsgClientUCMAddScreenshot', 'CMsgClientUCMAddScreenshotResponse', {...})

const path = require('path');
const Schema = require('steam-user/protobufs/generated/_load.js');
const EMsg = require('steam-user/enums/EMsg.js');
const EResult = require('steam-user/enums/EResult.js');
// the protobufjs copy steam-user itself uses
const { Root } = require(require.resolve('protobufjs', { paths: [path.dirname(require.resolve('steam-user'))] }));

const DEFAULT_TIMEOUT = 30_000;
const extra = {};

// Add message types steam-user doesn't know, as protobufjs JSON: { TypeName: { fields: { name: { type, id, rule? } } } }
function defineTypes(nested) {
	const root = Root.fromJSON({ nested });
	for (const name of Object.keys(nested)) extra[name] = root.lookupType(name);
}

function type(name) {
	const t = extra[name] || Schema[name];
	if (!t) throw new Error(`Unknown Steam message type ${name}`);
	return t;
}

const toBuffer = (body) => (Buffer.isBuffer(body) ? body : body && typeof body.toBuffer === 'function' ? body.toBuffer() : Buffer.alloc(0));
const encode = (typeName, obj) => { const t = type(typeName); return Buffer.from(t.encode(t.fromObject(obj)).finish()); };
const decode = (typeName, body) => {
	const t = type(typeName);
	return t.toObject(t.decode(toBuffer(body)), { longs: String, bytes: Buffer, defaults: true });
};

class SteamCallError extends Error {
	constructor(message, eresult) {
		super(message);
		this.eresult = eresult;
	}
}

// Replies that Steam sends without our job id, matched by message type + a test on the body instead
const waiters = new Map();   // emsg -> Set of { match, finish }
function hookReplies(client, emsg) {
	if (!waiters.has(emsg)) waiters.set(emsg, new Set());
	if (client._smiHooked?.has(emsg)) return;
	(client._smiHooked ??= new Set()).add(emsg);
	// HandlerManager dedupes handlers by their source text, so this is added once per message type
	client._handlerManager.add(emsg, function smiReplyHandler(body, header) {
		const set = waiters.get(header.msg);
		if (!set) return;
		for (const w of set) if (w.tryFinish(body, header)) break;
	});
}

// headerResult: only unified service replies fill in the header's eresult; on classic messages it's
// left out, and steam-user then decodes it as its default (2 = Fail), so there the body's eresult counts.
function request(client, header, body, resType, timeoutMs, untagged, headerResult = false) {
	return new Promise((resolve, reject) => {
		if (!client.steamID) return reject(new SteamCallError('Not connected to Steam'));
		let done = false;
		let waiter = null;
		const finish = (fn) => { if (done) return false; done = true; clearTimeout(timer); if (waiter) waiters.get(untagged.emsg)?.delete(waiter); fn(); return true; };
		const timer = setTimeout(() => finish(() => reject(new SteamCallError('Steam did not answer in time'))), timeoutMs);
		const handle = (resBody, resHeader) => finish(() => {
			const eresult = headerResult ? resHeader?.proto?.eresult : null;
			if (eresult != null && eresult !== EResult.OK) {
				const msg = resHeader.proto.error_message || EResult[eresult] || `error ${eresult}`;
				return reject(new SteamCallError(`Steam refused the request: ${msg}`, eresult));
			}
			try { resolve(decode(resType, resBody)); } catch (err) { reject(err); }
		});
		if (untagged) {
			hookReplies(client, untagged.emsg);
			waiter = {
				tryFinish(resBody, resHeader) {
					let decoded;
					try { decoded = decode(resType, resBody); } catch { return false; }
					if (!untagged.match(decoded)) return false;
					return finish(() => resolve(decoded)) || true;
				},
			};
			waiters.get(untagged.emsg).add(waiter);
		}
		client._send(header, body, handle);
	});
}

// A "unified" service method, e.g. Cloud.ClientBeginFileUpload#1
function callService(client, method, reqType, resType, body, timeoutMs = DEFAULT_TIMEOUT) {
	const header = { msg: EMsg.ServiceMethodCallFromClient, proto: { target_job_name: method } };
	return request(client, header, encode(reqType, body), resType, timeoutMs, null, true);
}

// A classic protobuf message with a reply, e.g. ClientUCMAddScreenshot -> ClientUCMAddScreenshotResponse.
// untagged: { emsg, match(decodedBody) } for replies Steam may send without our job id.
function sendMsg(client, emsg, reqType, resType, body, { timeoutMs = DEFAULT_TIMEOUT, untagged = null } = {}) {
	return request(client, { msg: emsg, proto: {} }, encode(reqType, body), resType, timeoutMs, untagged);
}

module.exports = { callService, sendMsg, defineTypes, SteamCallError, EMsg, EResult };
