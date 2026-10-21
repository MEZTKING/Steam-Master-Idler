#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const SteamUser = require('steam-user');
const QRCode = require('qrcode');
const { startQrLogin } = require('./lib/qr-login');
const { fetchCardDrops } = require('./lib/cards');

const DATA_DIR = process.env.IDLER_DATA_DIR || path.join(__dirname, '..');
const CONFIG_FILE = process.env.IDLER_CONFIG || path.join(DATA_DIR, 'config.json');
const SESSION_FILE = path.join(DATA_DIR, '.session');   // refresh token, so you only log in once
const STATE_FILE = path.join(DATA_DIR, 'state.json');   // resolved targets for "addHours" games

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

// ---------- helpers ----------

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const fmtH = (min) => `${(min / 60).toFixed(2)}h`;
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

function ask(question, hidden = false) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
		rl.question(question, (answer) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
	});
}

function parseArgs(argv) {
	const args = { list: false, games: [], stopAfter: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--list' || a === '-l') args.list = true;
		else if (a === '--game' || a === '-g') args.games.push(argv[++i]);
		else if (a === '--stop-after') args.stopAfter = parseFloat(argv[++i]);
		else if (a === '--reset') args.reset = true;
		else if (a === '--qr') args.qr = true;
		else if (a === '--cards') args.cards = true;
		else if (a === '--played-only') args.playedOnly = true;
		else if (a === '--help' || a === '-h') args.help = true;
		else { console.error(`Unknown argument: ${a}`); process.exit(1); }
	}
	return args;
}

// "730" -> forever, "730:100" -> until 100h total, "730:+5" -> 5 more hours
function parseGameSpec(spec) {
	const [id, target] = spec.split(':');
	const game = { appid: parseInt(id, 10) };
	if (!game.appid) throw new Error(`Bad game spec "${spec}"`);
	if (target) {
		if (target === 'cards') game.cards = true;
		else if (target.startsWith('+')) game.addHours = parseFloat(target.slice(1));
		else game.targetHours = parseFloat(target);
	}
	return game;
}

const HELP = `
Steam Master Idler (command line)

Usage:
  npm run cli --                     idle the games in config.json
  npm run cli -- --list              list your owned games and playtime
  npm run cli -- -g 730:100 -g 440   idle specific games (overrides config)
  npm run cli -- --stop-after 8      stop the whole session after 8 hours
  npm run cli -- --reset             forget saved "addHours" targets
  npm run cli -- --qr                log in by scanning a QR code in the Steam app
  npm run cli -- --cards             idle every game that still has card drops
  npm run cli -- --played-only       skip games you've never played (keeps them refundable)

Game spec:  APPID          idle forever
            APPID:100      idle until total playtime reaches 100h
            APPID:+5       idle for 5 more hours (remembered across restarts)
            APPID:cards    idle until the game's card drops run out
`;

// ---------- main ----------

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) return console.log(HELP);

	const config = Object.assign({
		username: '',
		password: '',
		persona: 'keep',
		customGameName: '',
		maxConcurrent: STEAM_MAX_GAMES,
		resyncMinutes: 10,
		cardCheckMinutes: 10,
		stopAfterHours: null,
		games: [],
	}, readJson(CONFIG_FILE, {}));

	if (args.games.length) config.games = args.games.map(parseGameSpec);
	if (args.stopAfter) config.stopAfterHours = args.stopAfter;
	if (args.reset && fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

	const maxConcurrent = Math.min(config.maxConcurrent, STEAM_MAX_GAMES - (config.customGameName ? 1 : 0));
	const state = readJson(STATE_FILE, { addTargets: {} });
	if (config.persona === 'online' && !config.configVersion) config.persona = 'keep';   // old default overrode the Steam app's status
	// fixed random login ID, so Steam doesn't replace the Steam app's session with ours (see server.js)
	if (!state.logonID) {
		state.logonID = 1 + Math.floor(Math.random() * 0xfffffffe);
		writeJson(STATE_FILE, state);
	}
	const LOGON_OPTS = { logonID: state.logonID, machineName: 'Steam Master Idler' };

	const client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true });

	// ---- login ----
	const refreshToken = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : null;
	if (refreshToken && !args.qr) {
		log('Logging in with saved session...');
		client.logOn({ refreshToken, ...LOGON_OPTS });
	} else if (args.qr) {
		const qr = startQrLogin({
			onQr: async (url) => console.log(`\nScan this in the Steam mobile app (Steam Guard → scan QR):\n\n${await QRCode.toString(url, { type: 'terminal', small: true })}`),
			onScanned: () => log('Scanned - approve the login in the Steam app.'),
		});
		const { refreshToken: token, accountName } = await qr.done;
		fs.writeFileSync(SESSION_FILE, token, { mode: 0o600 });
		log(`QR login approved for ${accountName}.`);
		client.logOn({ refreshToken: token, ...LOGON_OPTS });
	} else {
		const accountName = config.username || process.env.STEAM_USER || await ask('Steam username: ');
		const password = config.password || process.env.STEAM_PASS || await ask('Steam password: ', true);
		log(`Logging in as ${accountName}...`);
		client.logOn({ accountName, password, ...LOGON_OPTS });
	}
	// Steam Guard codes are prompted for automatically on stdin by steam-user;
	// mobile-app approvals also work.

	client.on('refreshToken', (token) => {
		fs.writeFileSync(SESSION_FILE, token, { mode: 0o600 });
	});

	client.on('error', (err) => {
		if (err.eresult === SteamUser.EResult.InvalidPassword || err.eresult === SteamUser.EResult.AccessDenied) {
			if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
			log('Login failed (saved session expired or bad credentials). Run again to log in.');
		} else if (err.eresult === SteamUser.EResult.LoggedInElsewhere) {
			log('Logged out: a game was launched on another device. Retrying in 5 minutes...');
			setTimeout(() => client.logOn({ refreshToken: fs.readFileSync(SESSION_FILE, 'utf8').trim(), ...LOGON_OPTS }), 5 * 60_000);
			return;
		} else {
			log('Error:', err.message);
		}
		process.exit(1);
	});

	let webCookies = null;
	const webReady = new Promise((resolve) => client.on('webSession', (_, cookies) => { webCookies = cookies; resolve(); }));

	await new Promise((resolve) => client.once('loggedOn', resolve));
	log(`Logged in as ${client.steamID.getSteamID64()}`);
	if (PERSONA[config.persona] != null) client.setPersona(PERSONA[config.persona]);

	// ---- --list mode ----
	if (args.list) {
		const { apps } = await client.getUserOwnedApps(client.steamID, { includePlayedFreeGames: true, includeFreeSub: true });
		apps.sort((a, b) => b.playtime_forever - a.playtime_forever);
		console.log('\n  APPID       HOURS  NAME');
		for (const a of apps) console.log(`  ${String(a.appid).padEnd(10)} ${(a.playtime_forever / 60).toFixed(1).padStart(6)}  ${a.name}`);
		console.log(`\n${apps.length} games`);
		client.logOff();
		return;
	}

	// ---- card drops ----
	let cardDrops = null;   // Map appid -> {name, dropsLeft}
	let lastWebLogOn = Date.now();
	async function checkCards() {
		await Promise.race([webReady, new Promise((r) => setTimeout(r, 30_000))]);
		try {
			cardDrops = await fetchCardDrops(client.steamID.getSteamID64(), webCookies);
		} catch (err) {
			if (/logged in/i.test(err.message) && Date.now() - lastWebLogOn > 5 * 60_000) {
				lastWebLogOn = Date.now();
				client.webLogOn();   // cookies expired; get fresh ones for next time
			}
			throw err;
		}
		return cardDrops;
	}

	if (args.cards) {
		log('Checking card drops...');
		const drops = [...(await checkCards()).values()].filter((g) => g.dropsLeft > 0);
		if (!drops.length) log('No games with card drops remaining.');
		config.games = drops.sort((a, b) => b.dropsLeft - a.dropsLeft).map((d) => ({ appid: d.appid, cards: true }));
	}

	if (!config.games.length) {
		log('No games configured. Add some to config.json or use --game APPID[:HOURS]. See --help.');
		client.logOff();
		return;
	}

	// ---- build game list with current playtime ----
	const owned = new Map();
	async function syncPlaytime() {
		const { apps } = await client.getUserOwnedApps(client.steamID, {
			includePlayedFreeGames: true, includeFreeSub: true,
			filterAppids: config.games.map((g) => g.appid),
		});
		for (const a of apps) owned.set(a.appid, a);
	}
	await syncPlaytime();

	if (args.playedOnly || config.playedOnly) {
		const before = config.games.length;
		config.games = config.games.filter((g) => owned.get(g.appid)?.playtime_forever > 0);
		if (before !== config.games.length) log(`Skipping ${before - config.games.length} game(s) you've never played.`);
		if (!config.games.length) {
			log('None of these games have been played before.');
			client.logOff();
			return;
		}
	}

	const games = config.games.map((g) => {
		const info = owned.get(g.appid);
		const minutes = info ? info.playtime_forever : 0;
		let targetMin = null;
		if (g.targetHours != null) {
			targetMin = g.targetHours * 60;
		} else if (g.addHours != null) {
			// remember the target so restarting doesn't add the hours again
			const key = `${g.appid}:${g.addHours}`;
			state.addTargets[key] ??= minutes + g.addHours * 60;
			targetMin = state.addTargets[key];
		}
		return {
			appid: g.appid,
			name: g.name || info?.name || `App ${g.appid}`,
			apiMin: minutes,      // last value reported by Steam
			baseMin: minutes,     // value when this idling run started
			localMs: 0,           // time we've idled it this run
			targetMin: g.cards ? null : targetMin,
			cards: !!g.cards,     // idle until card drops run out
			dropsLeft: g.cards && cardDrops ? (cardDrops.get(g.appid)?.dropsLeft || 0) : null,
			done: false,
		};
	});
	writeJson(STATE_FILE, state);

	function updateDrops() {
		let changed = false;
		for (const g of games) {
			if (!g.cards || g.done) continue;
			const left = cardDrops.get(g.appid)?.dropsLeft || 0;
			if (g.dropsLeft != null && left < g.dropsLeft) log(`🃏 ${g.name}: got ${g.dropsLeft - left} card(s), ${left} left.`);
			g.dropsLeft = left;
			if (left === 0) {
				g.done = true;
				changed = true;
				log(`✔ ${g.name} has no card drops left - done.`);
			}
		}
		return changed;
	}
	const hasCardGames = games.some((g) => g.cards);
	if (hasCardGames) {
		if (!cardDrops) await checkCards().catch((err) => log(`Card check failed: ${err.message}`));
		if (cardDrops) updateDrops();
	}

	for (const g of games) {
		if (!owned.has(g.appid)) log(`Warning: ${g.name} (${g.appid}) not found in your library - Steam may not count it.`);
	}

	const progress = (g) => Math.max(g.apiMin, g.baseMin + g.localMs / 60000);

	// ---- idling loop ----
	let active = [];
	let paused = false;
	let lastTick = Date.now();
	const sessionStart = Date.now();
	let idledMs = 0;

	function applyGames() {
		const next = games.filter((g) => !g.done).slice(0, maxConcurrent);
		const changed = next.map((g) => g.appid).join() !== active.map((g) => g.appid).join();
		active = next;
		const list = active.map((g) => g.appid);
		if (config.customGameName) list.unshift(config.customGameName);
		client.gamesPlayed(paused ? [] : list);
		if (changed && !paused) log(`Idling ${active.length} game(s): ${active.map((g) => g.name).join(', ') || '(none)'}`);
	}

	function tick() {
		const now = Date.now();
		const dt = now - lastTick;
		lastTick = now;
		if (paused) return;

		idledMs += dt;
		let changed = false;
		for (const g of active) {
			g.localMs += dt;
			if (!g.cards && g.targetMin != null && !g.done && progress(g) >= g.targetMin) {
				g.done = true;
				changed = true;
				log(`✔ ${g.name} reached ${fmtH(g.targetMin)} - done.`);
			}
		}
		if (changed) applyGames();

		if (games.every((g) => g.done)) return shutdown('All targets reached.');
		if (config.stopAfterHours && idledMs >= config.stopAfterHours * 3_600_000) {
			return shutdown(`Session limit of ${config.stopAfterHours}h reached.`);
		}
	}

	function status() {
		const lines = games.map((g) => {
			const p = progress(g);
			const tgt = g.cards ? ` (${g.dropsLeft == null ? '? ' : g.dropsLeft} card drops left)` : g.targetMin != null ? ` / ${fmtH(g.targetMin)} (${Math.min(100, (p / g.targetMin) * 100).toFixed(1)}%)` : ' (no limit)';
			const flag = g.done ? '✔' : active.includes(g) ? '▶' : '·';
			return `  ${flag} ${g.name.padEnd(30).slice(0, 30)} ${fmtH(p)}${tgt}`;
		});
		log(`Status${paused ? ' (PAUSED)' : ''} - session ${fmtH(idledMs / 60000)}\n${lines.join('\n')}`);
	}

	// pause when you start playing on another device, resume when you stop
	client.on('playingState', (blocked) => {
		if (blocked && !paused) {
			paused = true;
			client.gamesPlayed([]);
			log('You are playing elsewhere - idling paused.');
		} else if (!blocked && paused) {
			paused = false;
			lastTick = Date.now();
			log('Other session ended - resuming.');
			applyGames();
		}
	});

	client.on('loggedOn', () => {   // after an auto-relogin
		log('Reconnected.');
		paused = false;
		lastTick = Date.now();
		applyGames();
	});
	client.on('disconnected', () => { log('Disconnected - reconnecting...'); paused = true; });

	let shuttingDown = false;
	function shutdown(reason) {
		if (shuttingDown) return;
		shuttingDown = true;
		log(reason);
		status();
		client.gamesPlayed([]);
		setTimeout(() => { client.logOff(); process.exit(0); }, 1500);
	}
	process.on('SIGINT', () => shutdown('Stopped by user.'));
	process.on('SIGTERM', () => shutdown('Stopped.'));

	applyGames();
	tick();
	status();
	setInterval(tick, 10_000);
	setInterval(status, 10 * 60_000);
	if (hasCardGames) {
		setInterval(() => checkCards().then(() => {
			if (updateDrops()) applyGames();
			if (games.every((g) => g.done)) shutdown('All card drops collected.');
		}).catch((err) => log(`Card check failed: ${err.message}`)), config.cardCheckMinutes * 60_000);
	}
	setInterval(() => syncPlaytime().then(() => {
		for (const g of games) if (owned.has(g.appid)) g.apiMin = owned.get(g.appid).playtime_forever;
	}).catch(() => {}), config.resyncMinutes * 60_000);
}

main().catch((err) => { console.error(err); process.exit(1); });
