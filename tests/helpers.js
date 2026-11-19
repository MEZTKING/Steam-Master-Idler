'use strict';

// Shared bits for the tests: a throw-away home folder with a fake Steam install, tiny JPEGs, and a
// fake steam-user client that answers Steam requests from a table of handlers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Schema = require('steam-user/protobufs/generated/_load.js');
const EMsg = require('steam-user/enums/EMsg.js');
const HandlerManager = require('steam-user/components/classes/HandlerManager.js');

// a new empty HOME (Steam folders are found from it), removed after the test run
function tempHome(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kettle-test-'));
	const prev = process.env.HOME;
	process.env.HOME = dir;
	t?.after(() => { process.env.HOME = prev; fs.rmSync(dir, { recursive: true, force: true }); });
	return dir;
}

// <home>/.steam/steam/userdata/<account>/...
const steamUserdata = (home, account = 1) => path.join(home, '.steam', 'steam', 'userdata', String(account));
const screenshotsDir = (home, appid, account = 1) => path.join(steamUserdata(home, account), '760', 'remote', String(appid), 'screenshots');

function setRunningApp(home, appid) {
	fs.mkdirSync(path.join(home, '.steam'), { recursive: true });
	fs.writeFileSync(path.join(home, '.steam', 'registry.vdf'), `"Registry"{"HKCU"{"Software"{"Valve"{"Steam"{"RunningAppID" "${appid}"}}}}}`);
}

// smallest thing jpegSize() accepts: SOI + SOF0 with a size, plus some bytes so files differ
function jpeg(w = 1920, h = 1080, tag = '') {
	return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255]), Buffer.from(String(tag).padEnd(30, '.')), Buffer.from([0xff, 0xd9])]);
}

function writeShot(home, appid, name, { data = jpeg(1920, 1080, name), thumb = true, minutesAgo = 1 } = {}) {
	const dir = screenshotsDir(home, appid);
	fs.mkdirSync(path.join(dir, 'thumbnails'), { recursive: true });
	fs.writeFileSync(path.join(dir, name), data);
	if (thumb) fs.writeFileSync(path.join(dir, 'thumbnails', name), jpeg(200, 113, `t${name}`));
	const t = new Date(Date.now() - minutesAgo * 60_000);
	fs.utimesSync(path.join(dir, name), t, t);
	return path.join(dir, name);
}

const encode = (type, obj) => Buffer.from(Schema[type].encode(Schema[type].fromObject(obj)).finish());
const decode = (type, buf) => Schema[type].toObject(Schema[type].decode(buf), { longs: String });

// handlers: { 'Cloud.ClientBeginFileUpload#1': (req) => [responseType, responseObject, header?], ClientUCMAddScreenshot: ... }
// requests are decoded with the given request types; calls are recorded in client.calls
function fakeClient(handlers, requestTypes = {}) {
	const client = {
		steamID: { accountid: 1, getSteamID64: () => '76561197960265729' },
		cellID: 1,
		calls: [],
		licenses: [],
		_handlerManager: new HandlerManager(),
		on() {}, removeListener() {},
		gamesPlayed(list) { client.calls.push({ name: 'gamesPlayed', req: list }); },
		_send(header, body, cb) {
			const name = header.proto?.target_job_name || EMsg[header.msg];
			const reqType = requestTypes[name];
			const req = reqType ? decode(reqType, body) : null;
			client.calls.push({ name, req });
			const h = handlers[name];
			if (!h) return;
			const out = h(req, header);
			if (!out) return;
			const [type, obj, hdr = { proto: { eresult: 1 } }] = out;
			setImmediate(() => cb(type ? encode(type, obj) : Buffer.alloc(0), hdr));
		},
	};
	return client;
}

// a local HTTP server standing in for Steam Cloud storage
function storageServer(t, status = () => 200) {
	return new Promise((resolve) => {
		const puts = [];
		const srv = http.createServer((req, res) => {
			let n = 0;
			req.on('data', (c) => { n += c.length; });
			req.on('end', () => { puts.push({ url: req.url, bytes: n }); res.writeHead(status()); res.end(); });
		});
		srv.listen(0, '127.0.0.1', () => { t?.after(() => srv.close()); resolve({ host: `127.0.0.1:${srv.address().port}`, puts }); });
	});
}

// a tool's ctx with sensible defaults
function toolCtx(overrides = {}) {
	const logs = [];
	return {
		logs,
		client: overrides.client || fakeClient({}),
		desktop: true, mobile: false, config: {}, state: {}, justEnabled: false, dataDir: path.join(process.env.HOME, 'data'),
		log: (m) => logs.push(m), debug: () => {}, saveConfig() {}, saveState() {},
		isLoggedIn: () => true, accountId: () => 1, steamID64: () => '76561197960265729', country: () => 'DE',
		web: () => null, gameName: (a) => `App ${a}`, gameIcon: () => null, ownsApp: () => false, library: () => [], refreshLibrary: async () => {},
		playingElsewhere: () => 0, canSeePlaying: () => true, openPath() {},
		toolState: () => ({}), toolConfig: () => ({}), callTool: async () => ({}),
		withGamePlaying: async (appid, fn) => fn(),
		...overrides,
	};
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// wait until fn() is truthy (polling), or fail after ms
async function until(fn, ms = 3000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (await fn()) return; await wait(20); }
	throw new Error('timed out waiting');
}

module.exports = { tempHome, steamUserdata, screenshotsDir, setRunningApp, jpeg, writeShot, encode, decode, fakeClient, storageServer, toolCtx, wait, until, Schema, EMsg };
