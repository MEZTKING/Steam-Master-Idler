'use strict';

// Uploads one screenshot to your Steam Cloud screenshot library, the same way the Steam app does when
// you press Upload in its screenshot manager:
//   1. Cloud.ClientBeginFileUpload for the image (Steam Cloud app 760 = screenshots) -> where to PUT it
//   2. HTTP upload of the bytes, then Cloud.ClientCommitFileUpload
//   3. the same for the thumbnail
//   4. ClientUCMAddScreenshot: attach it to the game with a visibility (Private by default)
// "DuplicateRequest" from Steam means that file / screenshot is already there, which counts as done.

const crypto = require('crypto');
const { callService, sendMsg, EMsg, EResult } = require('../../lib/steam-cm');

const SCREENSHOTS_APP = 760;
const HTTP_METHODS = { 1: 'GET', 2: 'HEAD', 3: 'POST', 4: 'PUT', 5: 'DELETE', 6: 'OPTIONS', 7: 'PATCH' };
const SKIP_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);
// EUCMFilePrivacyState
const PRIVACY = { private: 2, friends: 4, public: 8, unlisted: 16 };

// tag an error with the step it happened in, so the log says where Steam refused
const step = (what, err) => Object.assign(new Error(`${what}: ${err.message}`), { eresult: err.eresult, permanent: err.permanent });

async function cloudUpload(client, cloudName, data, timestamp, debug) {
	const sha = crypto.createHash('sha1').update(data).digest();
	let begin;
	try {
		begin = await callService(client, 'Cloud.ClientBeginFileUpload#1',
		'CCloud_ClientBeginFileUpload_Request', 'CCloud_ClientBeginFileUpload_Response', {
			appid: SCREENSHOTS_APP,
			file_size: data.length,
			raw_file_size: data.length,
			file_sha: sha,
			time_stamp: String(timestamp),
			filename: cloudName,
			cell_id: client.cellID || 0,
			can_encrypt: false,
			is_shared_file: true,
		});
	} catch (err) {
		if (err.eresult === EResult.DuplicateRequest) { debug?.(`cloud ${cloudName}: already in Steam Cloud`); return 'exists'; }
		throw step('Steam Cloud refused to start the upload', err);
	}
	if (begin.encrypt_file) throw new Error('Steam asked for an encrypted upload, which is not supported');
	let ok = false;
	try {
		for (const b of begin.block_requests || []) {
			const url = `${b.use_https ? 'https' : 'http'}://${b.url_host}${b.url_path}`;
			const headers = {};
			for (const h of b.request_headers || []) if (!SKIP_HEADERS.has(String(h.name).toLowerCase())) headers[h.name] = h.value;
			const offset = Number(b.block_offset || 0);
			const body = b.explicit_body_data?.length ? b.explicit_body_data : data.subarray(offset, offset + (b.block_length || 0));
			const method = HTTP_METHODS[b.http_method] || 'PUT';
			const res = await fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
			debug?.(`cloud ${method} ${b.url_host} ${body.length} bytes -> HTTP ${res.status}`);
			if (!res.ok) throw new Error(`Uploading to Steam Cloud storage: HTTP ${res.status}`);
		}
		ok = true;
	} finally {
		// always commit: with transfer_succeeded=false Steam drops the half-done upload
		const commit = await callService(client, 'Cloud.ClientCommitFileUpload#1',
			'CCloud_ClientCommitFileUpload_Request', 'CCloud_ClientCommitFileUpload_Response', {
				transfer_succeeded: ok, appid: SCREENSHOTS_APP, file_sha: sha, filename: cloudName,
			}).catch((err) => { if (ok) throw step('Steam Cloud refused to finish the upload', err); return null; });
		if (ok && !commit?.file_committed) throw new Error('Steam Cloud did not accept the file');
	}
	return 'uploaded';
}

// shot: { appid, name, data (Buffer, JPEG), thumb (Buffer, JPEG), width, height, created (unix s) }
// Returns Steam's screenshot id.
// Returns { id, existed } - existed: Steam already had this screenshot
async function uploadScreenshot(client, shot, { privacy = 'private', caption = '', debug } = {}) {
	const filename = `${shot.appid}/screenshots/${shot.name}`;
	const thumbname = `${shot.appid}/screenshots/thumbnails/${shot.name}`;

	await cloudUpload(client, filename, shot.data, shot.created, debug);
	await cloudUpload(client, thumbname, shot.thumb, shot.created, debug);

	let res;
	try {
		res = await sendMsg(client, EMsg.ClientUCMAddScreenshot, 'CMsgClientUCMAddScreenshot', 'CMsgClientUCMAddScreenshotResponse', {
		appid: shot.appid,
		filename,
		thumbname,
		rtime32_created: shot.created,
		width: shot.width,
		height: shot.height,
		permissions: PRIVACY[privacy] ?? PRIVACY.private,
		caption: caption.slice(0, 140),
	});
	} catch (err) {
		throw step('Adding it to your screenshot library', err);
	}
	if (res.eresult === EResult.DuplicateRequest) return { id: null, existed: true };
	if (res.eresult !== EResult.OK) throw new Error(`Adding it to your screenshot library: Steam answered ${EResult[res.eresult] || res.eresult}`);
	return { id: String(res.screenshotid), existed: false };
}

// Width and height from a JPEG's SOF header (no image library needed)
function jpegSize(buf) {
	if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
	let i = 2;
	while (i + 9 < buf.length) {
		if (buf[i] !== 0xff) { i++; continue; }
		const marker = buf[i + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
		const len = buf.readUInt16BE(i + 2);
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
		}
		i += 2 + len;
	}
	return null;
}

module.exports = { uploadScreenshot, jpegSize, PRIVACY };
