'use strict';

// One of these runs per idled game (started by ./index.js). It connects to the Steam app running on
// this PC through the user's own steamclient library, with SteamAppId set, so Steam shows that game
// as running - the same way Idle Master and Steam Achievement Manager do. No game files are involved.
//
//   ELECTRON_RUN_AS_NODE=1 <app> helper.js <path to steamclient64.dll> <appid>
//
// Reports to the parent over IPC: {type: 'ready', via} or {type: 'error', message}; exits when the
// parent disconnects.

const [, , libPath, appidArg] = process.argv;
const appid = String(parseInt(appidArg, 10));
process.env.SteamAppId = appid;    // the Steam client reads these from the connecting process
process.env.SteamGameId = appid;

const send = (msg) => { try { process.send ? process.send(msg) : console.log(JSON.stringify(msg)); } catch {} };
const fail = (message, code = 1) => { send({ type: 'error', message }); setTimeout(() => process.exit(code), 50); };

let koffi;
let lib;
try {
	koffi = require('koffi');
	lib = koffi.load(libPath);
} catch (err) {
	fail(`Couldn't load Steam's client library (${libPath}): ${err.message}`);
	return;
}

// Two ways in: the flat exports steamclient has carried for years, or the ISteamClient interface
// (CreateSteamPipe, BReleaseSteamPipe, ConnectToGlobalUser, CreateLocalUser, ReleaseUser are its
// first five virtual methods in every version).
function viaFlatExports() {
	const createPipe = lib.func('int32 Steam_CreateSteamPipe()');
	const connectUser = lib.func('int32 Steam_ConnectToGlobalUser(int32 pipe)');
	const releaseUser = lib.func('void Steam_ReleaseUser(int32 pipe, int32 user)');
	const releasePipe = lib.func('bool Steam_BReleaseSteamPipe(int32 pipe)');
	return { createPipe, connectUser, releaseUser, releasePipe, via: 'flat exports' };
}

function viaInterface() {
	const createInterface = lib.func('void *CreateInterface(const char *name, int *rc)');
	for (const version of ['SteamClient021', 'SteamClient020', 'SteamClient019', 'SteamClient018', 'SteamClient017']) {
		const self = createInterface(version, null);
		if (!self) continue;
		const vtable = koffi.decode(self, 'void *');
		const fns = koffi.decode(vtable, koffi.array('void *', 5));
		const call = (i, proto, ...args) => koffi.call(fns[i], proto, self, ...args);
		const pCreate = koffi.proto(`int32 SC_CreateSteamPipe_${version}(void *self)`);
		const pRelPipe = koffi.proto(`bool SC_BReleaseSteamPipe_${version}(void *self, int32 pipe)`);
		const pConnect = koffi.proto(`int32 SC_ConnectToGlobalUser_${version}(void *self, int32 pipe)`);
		const pRelUser = koffi.proto(`void SC_ReleaseUser_${version}(void *self, int32 pipe, int32 user)`);
		return {
			createPipe: () => call(0, pCreate),
			releasePipe: (pipe) => call(1, pRelPipe, pipe),
			connectUser: (pipe) => call(2, pConnect, pipe),
			releaseUser: (pipe, user) => call(4, pRelUser, pipe, user),
			via: `interface ${version}`,
		};
	}
	throw new Error('no supported SteamClient interface');
}

let api;
const errors = [];
for (const make of [viaFlatExports, viaInterface]) {
	try { api = make(); break; } catch (err) { errors.push(err.message); }
}
if (!api) {
	fail(`Steam's client library has no usable entry points (${errors.join('; ')})`);
	return;
}

const pipe = api.createPipe();
if (!pipe) {
	fail('Steam is not running. Start the Steam app and log in, then try again.', 2);
	return;
}
const user = api.connectUser(pipe);
if (!user) {
	api.releasePipe(pipe);
	fail('The Steam app is running but not logged in.', 3);
	return;
}
send({ type: 'ready', via: api.via, appid });

let closed = false;
function shutdown() {
	if (closed) return;
	closed = true;
	try { api.releaseUser(pipe, user); api.releasePipe(pipe); } catch {}
	process.exit(0);
}
process.on('disconnect', shutdown);   // parent quit or stopped this game
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
setInterval(() => {}, 60_000);        // stay alive; Steam counts the game as running while we're connected
