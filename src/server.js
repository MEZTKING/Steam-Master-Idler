#!/usr/bin/env node
'use strict';

// Local web server behind the GUI. The desktop app (main.js) starts it in-process;
// `node src/server.js` runs it on its own - then open http://127.0.0.1:3000.
// Shares config.json / .session / state.json with the CLI (cli.js).

const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { exec } = require('child_process');
const SteamUser = require('steam-user');
const QRCode = require('qrcode');
const { startQrLogin } = require('./lib/qr-login');
const { fetchCardDrops } = require('./lib/cards');
const { createDebugLog } = require('./lib/debuglog');
const { SteamAppIdler, SUPPORTED: STEAM_APP_SUPPORTED } = require('./steamapp');

const DATA_DIR = process.env.IDLER_DATA_DIR || path.join(__dirname, '..');
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = process.env.IDLER_CONFIG || path.join(DATA_DIR, 'config.json');
const SESSION_FILE = path.join(DATA_DIR, '.session');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const debugLog = createDebugLog(path.join(DATA_DIR, 'logs'));
const INDEX_HTML = path.join(__dirname, '..', 'public', 'index.html');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = '127.0.0.1';

const VERSION = require('../package.json').version;
const STEAM_MAX_GAMES = 32;
// 'keep' = never touch the status, so your Steam app keeps whatever you set there
const PERSONA = {
	keep: null,
	offline: SteamUser.EPersonaState.Offline,
	online: SteamUser.EPersonaState.Online,
	busy: SteamUser.EPersonaState.Busy,
	away: SteamUser.EPersonaState.Away,
	snooze: SteamUser.EPersonaState.Snooze,
	invisible: SteamUser.EPersonaState.Invisible,
};

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const fmtH = (min) => `${(min / 60).toFixed(2)}h`;

const config = Object.assign({
	username: '',
	password: '',
	persona: 'keep',
	customGameName: '',
	maxConcurrent: STEAM_MAX_GAMES,
	resyncMinutes: 10,
	cardCheckMinutes: 10,
	stopAfterHours: null,
	playedOnly: false,     // skip games with no playtime (keeps them refundable)
	idleMethod: process.platform === 'win32' ? 'steamApp' : 'servers', // servers: our own Steam login plays the games | steamApp: through the Steam app on this PC
	cardMode: 'fast',      // fast | all | individual | simultaneous2h | individualFirst
	cardOrder: 'default',  // default (A-Z) | mostDrops | leastDrops
	theme: 'dark',
	showUsername: true,
	minimizeToTray: true,  // desktop app only
	preventSleep: true,    // desktop app only
	shutdownWhenDone: false,
	games: [],
}, readJson(CONFIG_FILE, {}));
const state = readJson(STATE_FILE, { addTargets: {} });

// Older versions defaulted to setting the status to Online, which overrides the Steam app's status.
if (!config.configVersion) {
	if (config.persona === 'online') config.persona = 'keep';
	config.configVersion = 2;
}
// v3: on Windows idle through the Steam app by default, so your own games keep working alongside
if (config.configVersion < 3) {
	if (process.platform === 'win32') config.idleMethod = 'steamApp';
	config.configVersion = 3;
	writeJson(CONFIG_FILE, config);
}

// A fixed, random login ID for this install. Steam replaces a session when another login comes from the
// same network with the same ID; steam-user's default (0) can collide with the Steam app, which then
// drops to offline mode. With our own ID the idler and the Steam app stay logged in side by side.
if (!state.logonID) {
	state.logonID = 1 + Math.floor(Math.random() * 0xfffffffe);
	writeJson(STATE_FILE, state);
}
const LOGON_OPTS = { logonID: state.logonID, machineName: 'Steam Master Idler' };
const applyPersona = () => { if (PERSONA[config.persona] != null) client.setPersona(PERSONA[config.persona]); };

// ---------- app state ----------

// 'log' (message) for every activity line; 'notify' (message) for ones worth a desktop notification;
// 'session' (idling: boolean) when idling starts/stops
const events = new EventEmitter();
const CARD_MODES = ['fast', 'all', 'individual', 'simultaneous2h', 'individualFirst'];
const CARD_ORDERS = ['default', 'mostDrops', 'leastDrops'];
const FAST_ALL_MS = 5 * 60_000;   // fast mode: all card games together this long...
const FAST_SOLO_MS = 15_000;      // ...then each one alone this long, then re-check drops

const logLines = [];
function log(msg, notify = false) {
	const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
	console.log(line);
	debugLog.write('info', msg);
	logLines.push(line);
	if (logLines.length > 200) logLines.shift();
	events.emit('log', msg);
	if (notify) events.emit('notify', msg);
}

const app = {
	status: 'loggedOut',   // loggedOut | loggingIn | needGuard | loggedIn
	guard: null,           // { domain, lastCodeWrong }
	error: null,
	account: null,
	library: [],
	qr: null,              // { svg, scanned } while a QR login is in progress
	cards: { loading: false, error: null, checkedAt: null, drops: {} },  // appid -> drops left
};
let guardCallback = null;
let qrLogin = null;
let webCookies = null;

// what the diagnostics report shows (never cookie values, tokens or passwords)
const diag = { webSessionAt: null, webSessionError: null, cookieNames: [], cards: null, steamCheck: null };

// idling session (null when not idling)
let session = null;
let timers = [];

// ---------- steam client ----------

const client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true });

client.on('steamGuard', (domain, callback, lastCodeWrong) => {
	app.status = 'needGuard';
	app.guard = { domain, lastCodeWrong };
	guardCallback = callback;
	log(lastCodeWrong ? 'Steam Guard code was wrong, try again.' : `Steam Guard code needed${domain ? ` (sent to ${domain})` : ' (mobile app)'} - you can also approve the login in the Steam app.`);
});

client.on('refreshToken', (token) => fs.writeFileSync(SESSION_FILE, token, { mode: 0o600 }));

client.on('loggedOn', async () => {
	app.status = 'loggedIn';
	app.guard = null;
	app.error = null;
	guardCallback = null;
	applyPersona();
	log(`Logged in as ${client.steamID.getSteamID64()}`);
	if (session) {
		session.disconnected = false;
		session.lastTick = Date.now();
		applyGames(false, true);
	}
	refreshLibrary().catch((err) => log(`Couldn't load library: ${err.message}`));
});

client.on('accountInfo', (name) => { app.account = name; });

client.on('debug', (msg) => {
	debugLog.write('steam', msg);   // includes "Sending message: ClientGamesPlayed..." / "Handled message: ..."
	if (/web session/i.test(String(msg))) diag.webSessionError = { at: Date.now(), message: String(msg) };
});

client.on('webSession', (sessionID, cookies) => {
	const first = !webCookies;
	webCookies = cookies;
	diag.webSessionAt = Date.now();
	diag.cookieNames = cookies.map((c) => c.split('=')[0]);
	debugLog.write('diag', 'web session received, cookies:', diag.cookieNames.join(','));
	if (first) refreshCards().catch(() => {});
});

client.on('disconnected', () => {
	if (session) session.disconnected = true;
	if (app.status === 'loggedIn') log('Disconnected - reconnecting...');
});

client.on('error', (err) => {
	debugLog.write('error', `steam client error eresult=${err.eresult}`, err);
	if (err.eresult === SteamUser.EResult.LoggedInElsewhere) {
		log('A game was started in Steam (here or on another PC), so Steam disconnected the idler. Steam only lets one session play at a time. Reconnecting every 5 minutes; idling resumes once that game is closed.');
		if (session) session.disconnected = true;
		setTimeout(loginWithSavedSession, 5 * 60_000);
		return;
	}
	if (err.eresult === SteamUser.EResult.InvalidPassword || err.eresult === SteamUser.EResult.AccessDenied) {
		if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
	}
	stopSession('Logged out.');
	app.status = 'loggedOut';
	app.guard = null;
	app.error = err.eresult === SteamUser.EResult.LogonSessionReplaced
		? 'Steam replaced this login with another one from this network. Log in again.'
		: err.message;
	log(`Login error: ${err.message}`);
});

client.on('playingState', (blocked, playingApp) => {
	app.playing = { blocked, appid: playingApp };
	debugLog.write('diag', `playingState blocked=${blocked} playingApp=${playingApp}`);
	if (!session || viaApp()) return;   // through the Steam app, your own games never conflict
	if (blocked && !session.blocked) {
		session.blocked = true;
		client.gamesPlayed([]);
		log('You are playing elsewhere - idling paused.');
	} else if (!blocked && session.blocked) {
		session.blocked = false;
		session.lastTick = Date.now();
		log('Other session ended - resuming.');
		applyGames(false, true);
	}
});

function loginWithSavedSession() {
	if (!fs.existsSync(SESSION_FILE)) return false;
	app.status = 'loggingIn';
	log('Logging in with saved session...');
	client.logOn({ refreshToken: fs.readFileSync(SESSION_FILE, 'utf8').trim(), ...LOGON_OPTS });
	return true;
}

// ---------- card drops ----------

let lastWebLogOn = 0;
async function refreshCards() {
	if (app.cards.loading) return;
	app.cards.loading = true;
	try {
		const drops = await fetchCardDrops(client.steamID.getSteamID64(), webCookies);
		diag.cards = { at: Date.now(), ok: true, games: drops.size, trace: drops.trace };
		debugLog.write('diag', `card check ok: ${drops.size} badges`, drops.trace);
		app.cards.drops = Object.fromEntries([...drops.values()].filter((g) => g.dropsLeft > 0).map((g) => [g.appid, g.dropsLeft]));
		app.cards.checkedAt = Date.now();
		app.cards.error = null;
		if (session) updateSessionDrops();
	} catch (err) {
		app.cards.error = err.message;
		diag.cards = { at: Date.now(), ok: false, error: err.message, trace: err.trace || [] };
		debugLog.write('diag', `card check failed: ${err.message}`, err.trace || [], err.stack || '');
		// cookies expire; ask steam-user for fresh ones (at most every 5 min)
		if (/logged in/i.test(err.message) && Date.now() - lastWebLogOn > 5 * 60_000 && app.status === 'loggedIn') {
			lastWebLogOn = Date.now();
			client.webLogOn();
		}
		throw err;
	} finally {
		app.cards.loading = false;
	}
}

function updateSessionDrops() {
	let changed = false;
	for (const g of session.games) {
		if (!g.cards || g.done) continue;
		const left = app.cards.drops[g.appid] || 0;
		if (g.dropsLeft != null && left < g.dropsLeft) log(`🃏 ${g.name}: got ${g.dropsLeft - left} card(s), ${left} left.`);
		g.dropsLeft = left;
		if (left === 0) {
			g.done = true;
			changed = true;
			log(`✔ ${g.name} has no card drops left - done.`, true);
		}
	}
	if (changed) applyGames();
}

async function refreshLibrary() {
	const { apps } = await client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeFreeSub: true });
	app.library = apps
		.map((a) => ({ appid: a.appid, name: a.name, minutes: a.playtime_forever, icon: a.img_icon_url || null }))
		.sort((a, b) => b.minutes - a.minutes);
	if (session) {
		for (const g of session.games) {
			const owned = app.library.find((a) => a.appid === g.appid);
			if (owned) g.apiMin = owned.minutes;
		}
	}
}

// ---------- idling ----------

const progress = (g) => Math.max(g.apiMin, g.baseMin + g.localMs / 60000);
// how the games are played: our own Steam login (servers), or helpers through the Steam app on this PC
const viaApp = () => config.idleMethod === 'steamApp';
const steamApp = new SteamAppIdler();
const helperErrors = new Map();   // appid -> last error logged, so each problem is logged once
steamApp.on('debug', (msg) => debugLog.write('steamapp', msg));
steamApp.on('ready', (appid, via) => {
	helperErrors.delete(appid);
	debugLog.write('steamapp', `ready ${appid} via ${via}`);
	const name = session?.games.find((g) => g.appid === appid)?.name || `App ${appid}`;
	log(`▶ ${name} is running through the Steam app.`);
	scheduleVerify(10_000);
});
steamApp.on('error', (appid, message) => {
	debugLog.write('steamapp', `error ${appid}: ${message}`);
	if (helperErrors.get(appid) === message) return;
	helperErrors.set(appid, message);
	const name = session?.games.find((g) => g.appid === appid)?.name || `App ${appid}`;
	log(`⚠ Couldn't run ${name} through the Steam app: ${message} Retrying every minute.`);
});

// through the Steam app, only games whose helper is connected are really running
const isRunning = (g) => !viaApp() || steamApp.status()[g.appid]?.state === 'running';

// Through the Steam app only a manual pause stops idling; playing elsewhere or our own login
// reconnecting doesn't matter there.
const isPaused = () => session && (session.paused || (!viaApp() && (session.blocked || session.disconnected)));

function sortCardGames(games) {
	const byName = (a, b) => a.name.localeCompare(b.name);
	if (config.cardOrder === 'mostDrops') return games.sort((a, b) => (b.dropsLeft ?? 0) - (a.dropsLeft ?? 0) || byName(a, b));
	if (config.cardOrder === 'leastDrops') return games.sort((a, b) => (a.dropsLeft ?? 0) - (b.dropsLeft ?? 0) || byName(a, b));
	return games.sort(byName);
}

// Which card games run right now, depending on the card idling behavior.
function pickCardGames(cardGames) {
	if (!cardGames.length) return [];
	const under2h = cardGames.filter((g) => progress(g) < 120);
	const over2h = cardGames.filter((g) => progress(g) >= 120);
	switch (config.cardMode) {
		case 'all': return cardGames;
		case 'individual': return cardGames.slice(0, 1);
		case 'simultaneous2h': return under2h.length ? under2h : cardGames.slice(0, 1);
		case 'individualFirst': return over2h.length ? over2h.slice(0, 1) : cardGames;
		default: {   // fast
			const ph = session.phase;
			return ph.name === 'solo' ? [cardGames[ph.idx % cardGames.length]] : cardGames;
		}
	}
}

function describePhase() {
	if (!session || !session.games.some((g) => g.cards && !g.done)) return null;
	if (config.cardMode !== 'fast') return null;
	const left = Math.max(0, session.phase.until - Date.now());
	return session.phase.name === 'solo'
		? `Fast mode: each game alone for a moment to trigger drops`
		: `Fast mode: all card games together (${Math.ceil(left / 60000)} min left)`;
}

function applyGames(quiet = false, force = false) {
	if (!session) return;
	const max = Math.min(config.maxConcurrent, STEAM_MAX_GAMES - (config.customGameName ? 1 : 0));
	const pending = session.games.filter((g) => !g.done);
	const cardGames = sortCardGames(pending.filter((g) => g.cards));
	const next = [...pickCardGames(cardGames), ...pending.filter((g) => !g.cards)].slice(0, max);
	const changed = next.map((g) => g.appid).join() !== session.active.map((g) => g.appid).join();
	session.active = next;
	const list = next.map((g) => g.appid);
	if (config.customGameName) list.unshift(config.customGameName);
	const send = isPaused() ? [] : list;
	if (viaApp()) {
		steamApp.set(isPaused() ? [] : next.map((g) => g.appid));   // custom status text needs our own login, so it's skipped here
		if (session.lastSent !== '[]') { client.gamesPlayed([]); session.lastSent = '[]'; }   // our own login plays nothing
	} else if (force || JSON.stringify(send) !== session.lastSent) {
		steamApp.stopAll();
		client.gamesPlayed(send);
		session.lastSent = JSON.stringify(send);
		debugLog.write('diag', 'gamesPlayed sent', send);
	}
	if (send.length && (changed || force)) scheduleVerify();
	if (changed && next.length && !isPaused() && !quiet) log(`Idling ${next.length} game(s): ${next.map((g) => g.name).join(', ') || '(none)'}`);
}

// Ask Steam what it shows us playing, so the page can prove idling really works.
let verifyTimer = null;
function scheduleVerify(delay = 15_000) {
	clearTimeout(verifyTimer);
	verifyTimer = setTimeout(verifyInGame, delay);
}
async function verifyInGame() {
	if (!session) return;
	scheduleVerify(5 * 60_000);   // and keep re-checking while idling
	if (isPaused() || !session.active.length) return;
	const me = client.steamID.getSteamID64();
	const activeIds = session.active.map((g) => String(g.appid));
	// Three ways Steam tells us what we're playing; any one confirming is enough.
	const sources = {
		playingSession: String(app.playing?.appid || 0),      // ClientPlayingSessionState
		persona: String(client.users?.[me]?.gameid || 0),       // our own persona update
		lookup: '0',
	};
	try {
		const { personas } = await client.getPersonas([me]);
		sources.lookup = String(personas[me]?.gameid || personas[me]?.game_played_app_id || 0);
	} catch (err) {
		sources.lookup = `error: ${err.message}`;
	}
	const hit = Object.values(sources).find((id) => activeIds.includes(id) || (config.customGameName && id.length > 10 && id !== '0'));
	const hidden = config.persona === 'invisible' || config.persona === 'offline';
	const was = session.steamCheck?.state;
	const state = hit ? 'ok' : hidden ? 'hidden' : 'notInGame';
	const name = hit ? (session.games.find((g) => String(g.appid) === hit)?.name || `App ${hit}`) : null;
	session.steamCheck = { state, game: name, at: Date.now() };
	diag.steamCheck = { at: Date.now(), state, sources, active: activeIds, playing: app.playing || null };
	debugLog.write('diag', 'in-game check', diag.steamCheck);
	if (state === 'ok' && was !== 'ok') log(`✔ Steam confirms you're in-game (${name}). Playtime is being counted.`);
	if (state === 'notInGame' && was !== 'notInGame') {
		log(viaApp()
			? "⚠ Steam does not show you in-game yet. Make sure the Steam app is running and logged in to the same account as the idler. If it is, use Settings → Save debug report and send the file over."
			: "⚠ Steam does not show you in-game. If a game is running in the Steam app (here or on another PC), close it, or switch Settings → Idling method to \"Through the Steam app\". Otherwise use Settings → Save debug report and send the file over.");
	}
}

// fast mode: all together for 5 min -> each game alone for 15 s -> re-check drops -> repeat
function advanceFastMode(now) {
	if (config.cardMode !== 'fast') return;
	const cardGames = session.games.filter((g) => g.cards && !g.done);
	if (!cardGames.length || now < session.phase.until) return;
	const ph = session.phase;
	if (ph.name === 'all') {
		session.phase = { name: 'solo', idx: 0, until: now + FAST_SOLO_MS };
		log(`Fast mode: idling each of ${cardGames.length} card game(s) on its own for a moment.`);
		applyGames(true);
	} else if (ph.idx + 1 < cardGames.length) {
		session.phase = { name: 'solo', idx: ph.idx + 1, until: now + FAST_SOLO_MS };
		applyGames(true);
	} else {
		session.phase = { name: 'all', idx: 0, until: now + FAST_ALL_MS };
		log(`Fast mode: idling all ${cardGames.length} card game(s) together for 5 minutes.`);
		applyGames(true);
		refreshCards().catch((err) => log(`Card check failed: ${err.message}`));
	}
}

let lastHelperRetry = 0;
function tick() {
	if (!session) return;
	const now = Date.now();
	if (viaApp() && now - lastHelperRetry > 60_000) {   // e.g. Steam wasn't running yet
		lastHelperRetry = now;
		steamApp.retryFailed();
		applyGames(true);
	}
	const dt = now - session.lastTick;
	session.lastTick = now;
	if (isPaused()) return;

	if (session.active.some(isRunning)) session.idledMs += dt;
	let changed = false;
	for (const g of session.active) {
		if (!isRunning(g)) continue;
		g.localMs += dt;
		if (!g.cards && g.targetMin != null && !g.done && progress(g) >= g.targetMin) {
			g.done = true;
			changed = true;
			log(`✔ ${g.name} reached ${fmtH(g.targetMin)} - done.`, true);
		}
	}
	if (changed) applyGames();
	else if (config.cardMode === 'simultaneous2h' || config.cardMode === 'individualFirst') applyGames();  // games cross 2h
	advanceFastMode(now);

	if (session.games.every((g) => g.done)) return finishSession(session.kind === 'cards' ? 'All card drops collected.' : 'All targets reached.');
	if (session.stopAfterHours && session.idledMs >= session.stopAfterHours * 3_600_000) {
		return finishSession(`Session limit of ${session.stopAfterHours}h reached.`);
	}
}

// natural end of a session (not a manual stop): optionally shut the computer down
function finishSession(reason) {
	stopSession(reason, true);
	if (config.shutdownWhenDone) scheduleShutdown();
}

let shutdownTimer = null;
function scheduleShutdown() {
	app.shutdownAt = Date.now() + 60_000;
	log('Shutting down the computer in 60 seconds (you can cancel this).', true);
	shutdownTimer = setTimeout(() => {
		app.shutdownAt = null;
		const cmd = process.platform === 'win32' ? 'shutdown /s /t 0'
			: process.platform === 'darwin' ? `osascript -e 'tell app "System Events" to shut down'`
			: 'systemctl poweroff';
		log('Shutting down now.');
		exec(cmd, (err) => err && log(`Couldn't shut down: ${err.message}`));
	}, 60_000);
}
function cancelShutdown() {
	clearTimeout(shutdownTimer);
	shutdownTimer = null;
	if (app.shutdownAt) log('Shutdown cancelled.');
	app.shutdownAt = null;
}

const hasPlayed = (appid) => (app.library.find((a) => a.appid === appid)?.minutes || 0) > 0;

// re-check card drops regularly while any card game is being idled
function ensureCardChecks() {
	if (session.cardTimer) return;
	session.cardTimer = setInterval(() => refreshCards().catch((err) => log(`Card check failed: ${err.message}`)), config.cardCheckMinutes * 60_000);
	timers.push(session.cardTimer);
	if (!app.cards.checkedAt) refreshCards().catch((err) => log(`Card check failed: ${err.message}`));
}

// queue/config entry ({appid, targetHours | addHours | cards}) -> a game being idled
function resolveGame(g) {
	const owned = app.library.find((a) => a.appid === g.appid);
	const minutes = owned ? owned.minutes : 0;
	let targetMin = null;
	if (g.targetHours != null) {
		targetMin = g.targetHours * 60;
	} else if (g.addHours != null) {
		const key = `${g.appid}:${g.addHours}`;
		state.addTargets[key] ??= minutes + g.addHours * 60;
		targetMin = state.addTargets[key];
	}
	const cards = !!g.cards;
	const dropsLeft = cards && app.cards.checkedAt ? (app.cards.drops[g.appid] || 0) : null;
	return {
		appid: g.appid,
		name: owned?.name || `App ${g.appid}`,
		icon: owned?.icon || null,
		apiMin: minutes,
		baseMin: minutes,
		localMs: 0,
		targetMin: cards ? null : targetMin,
		cards,
		dropsLeft,
		done: cards ? dropsLeft === 0 : targetMin != null && minutes >= targetMin,
	};
}

function startSession(games, kind = 'hours') {
	cancelShutdown();
	if (config.playedOnly) {
		const skipped = games.filter((g) => !hasPlayed(g.appid));
		games = games.filter((g) => hasPlayed(g.appid));
		if (!games.length) throw new Error("None of these games have been played before. Turn off \"Only games I've played\" to idle them.");
		for (const g of skipped) log(`Skipping ${app.library.find((a) => a.appid === g.appid)?.name || `App ${g.appid}`} - never played.`);
	}
	if (session) stopSession('Restarting with new settings.');
	const resolved = games.map(resolveGame);
	writeJson(STATE_FILE, state);

	session = {
		games: resolved,
		active: [],
		paused: false,
		blocked: client.playingState?.blocked || false,
		disconnected: false,
		idledMs: 0,
		lastTick: Date.now(),
		startedAt: Date.now(),
		stopAfterHours: config.stopAfterHours,
		steamCheck: null,
		kind,
		phase: { name: 'all', idx: 0, until: Date.now() + FAST_ALL_MS },
	};
	events.emit('session', true);
	if (session.blocked) log('Steam says a game is running in another Steam session (another PC, or the Steam app here). Idling starts as soon as it closes.');
	log(`Started idling ${resolved.length} game(s).`);
	for (const g of resolved) if (g.done) log(`${g.name} ${g.cards ? 'has no card drops left' : 'is already past its target'} - skipping.`);
	applyGames();
	timers = [
		setInterval(tick, 5_000),
		setInterval(() => refreshLibrary().catch(() => {}), config.resyncMinutes * 60_000),
	];
	if (resolved.some((g) => g.cards)) ensureCardChecks();
	tick();
}

function stopSession(reason, notify = false) {
	if (!session) return;
	timers.forEach(clearInterval);
	timers = [];
	clearTimeout(verifyTimer);
	session = null;
	client.gamesPlayed([]);
	steamApp.stopAll();
	helperErrors.clear();
	log(reason, notify);
	events.emit('session', false);
}

// ---------- http api ----------

function snapshot() {
	// time idled since the last tick, so clocks in the page move every second, not every 5
	const live = session && !isPaused() && session.active.some(isRunning) ? Date.now() - session.lastTick : 0;
	return {
		status: app.status,
		guard: app.guard,
		error: app.error,
		account: app.account,
		hasSavedSession: fs.existsSync(SESSION_FILE),
		desktop: process.env.IDLER_DESKTOP === '1',
		version: VERSION,
		steamApp: { supported: STEAM_APP_SUPPORTED, ...(STEAM_APP_SUPPORTED ? steamApp.available() : { ok: false }) },
		shutdownAt: app.shutdownAt || null,
		config: { ...config, password: undefined },
		library: app.library,
		qr: app.qr,
		cards: { ...app.cards, ready: !!webCookies },
		session: session && {
			paused: session.paused,
			blocked: session.blocked,
			disconnected: session.disconnected,
			idledMs: session.idledMs + live,
			stopAfterHours: session.stopAfterHours,
			kind: session.kind,
			method: config.idleMethod,
			effectivePaused: !!isPaused(),
			phase: describePhase(),
			steamCheck: session.steamCheck,
			games: session.games.map((g) => ({
				appid: g.appid, name: g.name, icon: g.icon,
				minutes: progress(g), targetMin: g.targetMin, done: g.done,
				sessionMs: g.localMs + (session.active.includes(g) && isRunning(g) ? live : 0),
				cards: g.cards, dropsLeft: g.dropsLeft,
				active: session.active.includes(g),
				helper: viaApp() ? (steamApp.status()[g.appid] || null) : null,
			})),
		},
		log: logLines.slice(-100),
	};
}

function cleanGames(list) {
	if (!Array.isArray(list)) throw new Error('games must be a list');
	return list.map((g) => {
		const appid = parseInt(g.appid, 10);
		if (!appid) throw new Error('Bad appid');
		const out = { appid };
		if (g.cards) out.cards = true;
		else if (g.targetHours != null && g.targetHours !== '') out.targetHours = Math.max(0, parseFloat(g.targetHours));
		else if (g.addHours != null && g.addHours !== '') out.addHours = Math.max(0, parseFloat(g.addHours));
		return out;
	});
}

function applySettings(body) {
	if (body.persona in PERSONA) {
		config.persona = body.persona;
		if (app.status === 'loggedIn') applyPersona();
	}
	if (typeof body.customGameName === 'string') config.customGameName = body.customGameName.slice(0, 64);
	if ('stopAfterHours' in body) {
		const h = parseFloat(body.stopAfterHours);
		config.stopAfterHours = h > 0 ? h : null;
		if (session) session.stopAfterHours = config.stopAfterHours;
	}
	if ((body.idleMethod === 'servers' || body.idleMethod === 'steamApp') && body.idleMethod !== config.idleMethod) {
		config.idleMethod = body.idleMethod;
		log(viaApp() ? 'Idling through the Steam app on this PC.' : "Idling with the idler's own Steam login.");
		if (session) { session.lastSent = null; helperErrors.clear(); applyGames(false, true); }
	}
	for (const k of ['playedOnly', 'showUsername', 'minimizeToTray', 'preventSleep', 'shutdownWhenDone']) {
		if (k in body) config[k] = !!body[k];
	}
	if (CARD_MODES.includes(body.cardMode) && body.cardMode !== config.cardMode) {
		config.cardMode = body.cardMode;
		if (session) { session.phase = { name: 'all', idx: 0, until: Date.now() + FAST_ALL_MS }; applyGames(); }
	}
	if (CARD_ORDERS.includes(body.cardOrder)) { config.cardOrder = body.cardOrder; if (session) applyGames(); }
	if (body.theme === 'dark' || body.theme === 'light') config.theme = body.theme;
	events.emit('config', config);
	if ('maxConcurrent' in body) config.maxConcurrent = Math.min(STEAM_MAX_GAMES, Math.max(1, parseInt(body.maxConcurrent, 10) || STEAM_MAX_GAMES));
	if (body.games) config.games = cleanGames(body.games);
	writeJson(CONFIG_FILE, config);
}

const routes = {
	'GET /api/state': () => snapshot(),

	// support info to paste into a bug report: no cookie values, tokens or passwords
	'GET /api/diagnostics': () => ({
		version: VERSION,
		platform: `${process.platform} ${process.arch}`,
		logsFolder: debugLog.dir,
		electron: process.versions.electron || null,
		node: process.versions.node,
		desktop: process.env.IDLER_DESKTOP === '1',
		status: app.status,
		persona: config.persona,
		playedOnly: config.playedOnly,
		cardMode: config.cardMode,
		idleMethod: config.idleMethod,
		steamApp: { supported: STEAM_APP_SUPPORTED, ...(STEAM_APP_SUPPORTED ? steamApp.available() : {}), helpers: steamApp.status() },
		libraryGames: app.library.length,
		playingState: app.playing || null,
		session: session && {
			kind: session.kind, paused: session.paused, blocked: session.blocked, disconnected: session.disconnected,
			idledMin: Math.round(session.idledMs / 60000), active: session.active.map((g) => g.appid), lastSent: session.lastSent,
		},
		webSession: { at: diag.webSessionAt, cookieNames: diag.cookieNames, lastError: diag.webSessionError },
		cardCheck: diag.cards,
		steamCheck: diag.steamCheck,
		log: logLines.slice(-60),
	}),

	'POST /api/login': (body) => {
		if (app.status === 'loggedIn' || app.status === 'loggingIn') throw new Error('Already logged in');
		if (!body.username || !body.password) throw new Error('Enter username and password');
		app.status = 'loggingIn';
		app.error = null;
		log(`Logging in as ${body.username}...`);
		client.logOn({ accountName: body.username, password: body.password, ...LOGON_OPTS });
	},

	'POST /api/login/qr': async () => {
		if (app.status === 'loggedIn' || app.status === 'loggingIn') throw new Error('Already logged in');
		qrLogin?.cancel();
		app.error = null;
		app.qr = { svg: null, scanned: false };
		const attempt = startQrLogin({
			onQr: async (url) => {
				if (qrLogin !== attempt) return;
				app.qr = { svg: await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } }), scanned: app.qr?.scanned || false };
			},
			onScanned: () => {
				if (qrLogin !== attempt) return;
				app.qr.scanned = true;
				log('QR code scanned - approve the login in the Steam app.');
			},
		});
		qrLogin = attempt;
		attempt.done.then(({ refreshToken, accountName }) => {
			if (qrLogin !== attempt) return;
			qrLogin = null;
			app.qr = null;
			fs.writeFileSync(SESSION_FILE, refreshToken, { mode: 0o600 });
			app.status = 'loggingIn';
			log(`QR login approved for ${accountName}.`);
			client.logOn({ refreshToken, ...LOGON_OPTS });
		}).catch((err) => {
			if (qrLogin !== attempt) return;
			qrLogin = null;
			app.qr = null;
			app.error = err.message;
			log(`QR login: ${err.message}`);
		});
	},

	'POST /api/login/qr/cancel': () => {
		qrLogin?.cancel();
		qrLogin = null;
		app.qr = null;
	},

	'POST /api/cards/refresh': async () => {
		if (app.status !== 'loggedIn') throw new Error('Log in first');
		await refreshCards();
	},

	'POST /api/guard': (body) => {
		if (!guardCallback) throw new Error('No Steam Guard code requested');
		app.status = 'loggingIn';
		const cb = guardCallback;
		guardCallback = null;
		cb(String(body.code || '').trim());
	},

	'POST /api/logout': () => {
		stopSession('Logged out.');
		client.logOff();
		if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
		app.status = 'loggedOut';
		app.library = [];
		app.account = null;
		app.cards = { loading: false, error: null, checkedAt: null, drops: {} };
		webCookies = null;
		log('Logged out and forgot saved session.');
	},

	'POST /api/library/refresh': async () => { await refreshLibrary(); },

	'POST /api/settings': (body) => { applySettings(body); },

	'POST /api/start': (body) => {
		if (app.status !== 'loggedIn') throw new Error('Log in first');
		applySettings(body);
		if (!config.games.length) throw new Error('Add at least one game to the queue');
		startSession(config.games);
	},

	// card idler: farm every game that still has drops, using the card behavior + order settings
	'POST /api/start-cards': async () => {
		if (app.status !== 'loggedIn') throw new Error('Log in first');
		try { await refreshCards(); } catch (err) { if (!app.cards.checkedAt) throw new Error(`Couldn't check card drops: ${err.message}`); }
		const games = Object.keys(app.cards.drops).map(Number);
		if (!games.length) throw new Error('No games with card drops left.');
		startSession(games.map((appid) => ({ appid, cards: true })), 'cards');
	},

	// one text file with the diagnostics + the debug log, to attach to a bug report
	'GET /api/debug-report': () => {
		const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
		const body = [
			`Steam Master Idler debug report - ${new Date().toISOString()}`,
			'Tokens, cookie values and passwords are removed.',
			'',
			'=== Diagnostics ===',
			JSON.stringify(routes['GET /api/diagnostics'](), null, 2),
			'',
			'=== Debug log (newest last) ===',
			debugLog.tail(4000),
		].join('\n');
		return { raw: true, type: 'text/plain; charset=utf-8', filename: `steam-master-idler-debug-${stamp}.txt`, body };
	},

	'POST /api/open-logs': () => {
		if (process.env.IDLER_DESKTOP !== '1') throw new Error(`The logs are in ${debugLog.dir}`);
		events.emit('openPath', debugLog.dir);
	},

	'POST /api/cancel-shutdown': () => { cancelShutdown(); },

	'POST /api/stop': () => { stopSession('Stopped.'); },

	// add a game to the running session (it starts right away if there's a free slot)
	'POST /api/session/add': (body) => {
		if (!session) throw new Error('Not idling');
		const [g] = cleanGames([body]);
		if (session.games.some((x) => x.appid === g.appid && !x.done)) throw new Error('Already idling that game');
		if (config.playedOnly && !hasPlayed(g.appid)) throw new Error("You haven't played that game yet (Settings → Idle only games I've played before).");
		session.games = session.games.filter((x) => x.appid !== g.appid);   // re-adding a finished game restarts it
		const game = resolveGame(g);
		writeJson(STATE_FILE, state);
		session.games.push(game);
		if (game.cards) ensureCardChecks();
		log(`Added ${game.name} to the running session.`);
		applyGames(false, true);
		// keep the hours queue in step, so the next Start includes it too
		if (session.kind === 'hours' && !config.games.some((x) => x.appid === g.appid)) {
			config.games.push(g);
			writeJson(CONFIG_FILE, config);
		}
	},

	'POST /api/session/remove': (body) => {
		if (!session) throw new Error('Not idling');
		const appid = parseInt(body.appid, 10);
		const game = session.games.find((x) => x.appid === appid);
		if (!game) throw new Error('Not in this session');
		session.games = session.games.filter((x) => x !== game);
		log(`Removed ${game.name} from the running session.`);
		if (!session.games.some((x) => !x.done)) return stopSession('Stopped (no games left).');
		applyGames(false, true);
	},

	'POST /api/pause': () => {
		if (!session) throw new Error('Not idling');
		session.paused = !session.paused;
		session.lastTick = Date.now();
		log(session.paused ? 'Paused.' : 'Resumed.');
		applyGames(false, true);
	},

	'POST /api/reset-targets': () => {
		state.addTargets = {};
		writeJson(STATE_FILE, state);
		log('Forgot saved "more hours" targets.');
	},
};

const server = http.createServer(async (req, res) => {
	// only accept requests addressed to this machine (blocks DNS-rebinding)
	const host = (req.headers.host || '').split(':')[0];
	if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end(); }

	const url = req.url.split('?')[0];
	if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		return res.end(fs.readFileSync(INDEX_HTML));
	}

	const handler = routes[`${req.method} ${url}`];
	if (!handler) { res.writeHead(404); return res.end(); }

	// POSTs must be JSON from our own page (blocks cross-site form posts)
	if (req.method === 'POST') {
		const origin = req.headers.origin;
		if (!(req.headers['content-type'] || '').startsWith('application/json') ||
			(origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
			res.writeHead(403); return res.end();
		}
	}

	let raw = '';
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 1e6) { res.writeHead(413); return res.end(); }
	}
	if (req.method === 'POST') debugLog.write('api', req.method, url);   // never the body (it can hold a password)
	try {
		const result = await handler(raw ? JSON.parse(raw) : {});
		if (result?.raw) {
			res.writeHead(200, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.filename}"`, 'Cache-Control': 'no-store' });
			return res.end(result.body);
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result ?? { ok: true }));
	} catch (err) {
		debugLog.write('error', `${req.method} ${url} failed:`, err);
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: err.message }));
	}
});

// Starts the server; resolves with the URL. Pass port 0 to pick any free port.
function start(port = PORT) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, HOST, () => {
			const url = `http://${HOST}:${server.address().port}`;
			debugLog.write('info', `=== start v${VERSION} ${process.platform} ${process.arch} electron=${process.versions.electron || '-'} node=${process.versions.node} desktop=${process.env.IDLER_DESKTOP === '1'} ===`);
			log(`GUI running at ${url}`);
			loginWithSavedSession();
			resolve(url);
		});
	});
}

// Stops idling and logs off Steam (so you don't stay "in-game" after quitting).
function stop() {
	stopSession('Shutting down.');
	return new Promise((resolve) => setTimeout(() => {
		client.logOff();
		server.close();
		resolve();
	}, 1000));
}

const isIdling = () => !!session;

// crashes and stray promise errors go into the debug log too (without changing how they're handled)
process.on('uncaughtExceptionMonitor', (err) => debugLog.write('crash', err));
process.on('unhandledRejection', (err) => debugLog.write('error', 'unhandled rejection:', err));

const getConfig = () => config;

module.exports = { start, stop, events, isIdling, getConfig, DATA_DIR };

if (require.main === module) {
	start().catch((err) => { console.error(err.message); process.exit(1); });
	const shutdown = () => stop().then(() => process.exit(0));
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
