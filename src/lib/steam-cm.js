'use strict';

// Raw requests to Steam's client network (CM) over steam-user's connection, for features steam-user
// has no method for (Steam Cloud uploads, screenshots, ...). Uses steam-user's own protobuf schema.
//
//   await callService(client, 'Cloud.ClientBeginFileUpload#1', 'CCloud_ClientBeginFileUpload_Request',
//                     'CCloud_ClientBeginFileUpload_Response', { appid: 760, ... })
//   await sendMsg(client, EMsg.ClientUCMAddScreenshot, 'CMsgClientUCMAddScreenshot', 'CMsgClientUCMAddScreenshotResponse', {...})

const Schema = require('steam-user/protobufs/generated/_load.js');
const EMsg = require('steam-user/enums/EMsg.js');
const EResult = require('steam-user/enums/EResult.js');

const DEFAULT_TIMEOUT = 30_000;

function type(name) {
	const t = Schema[name];
	if (!t) throw new Error(`Unknown Steam message type ${name}`);
	return t;
}

const encode = (typeName, obj) => { const t = type(typeName); return Buffer.from(t.encode(t.fromObject(obj)).finish()); };
const decode = (typeName, body) => {
	const t = type(typeName);
	const buf = Buffer.isBuffer(body) ? body : body && typeof body.toBuffer === 'function' ? body.toBuffer() : Buffer.alloc(0);
	return t.toObject(t.decode(buf), { longs: String, bytes: Buffer, defaults: true });
};

class SteamCallError extends Error {
	constructor(message, eresult) {
		super(message);
		this.eresult = eresult;
	}
}

function request(client, header, body, resType, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (!client.steamID) return reject(new SteamCallError('Not connected to Steam'));
		const timer = setTimeout(() => reject(new SteamCallError('Steam did not answer in time')), timeoutMs);
		client._send(header, body, (resBody, resHeader) => {
			clearTimeout(timer);
			const eresult = resHeader?.proto?.eresult;
			if (eresult != null && eresult !== EResult.OK) {
				const msg = resHeader.proto.error_message || EResult[eresult] || `error ${eresult}`;
				return reject(new SteamCallError(`Steam refused the request: ${msg}`, eresult));
			}
			try { resolve(decode(resType, resBody)); } catch (err) { reject(err); }
		});
	});
}

// A "unified" service method, e.g. Cloud.ClientBeginFileUpload#1
function callService(client, method, reqType, resType, body, timeoutMs = DEFAULT_TIMEOUT) {
	const header = { msg: EMsg.ServiceMethodCallFromClient, proto: { target_job_name: method } };
	return request(client, header, encode(reqType, body), resType, timeoutMs);
}

// A classic protobuf message with a reply, e.g. ClientUCMAddScreenshot -> ClientUCMAddScreenshotResponse
function sendMsg(client, emsg, reqType, resType, body, timeoutMs = DEFAULT_TIMEOUT) {
	return request(client, { msg: emsg, proto: {} }, encode(reqType, body), resType, timeoutMs);
}

module.exports = { callService, sendMsg, SteamCallError, EMsg, EResult };
