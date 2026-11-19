'use strict';

// In-app updates from the project's GitHub Releases. One small request to the GitHub API shortly
// after start and every 12 hours (no update framework, nothing running in between). When there's a
// newer version it picks the right download for this install:
//   Windows installer -> Setup .exe, run silently, the app restarts itself (main.js)
//   Windows portable  -> Portable .exe saved next to the old one, then started (main.js)
//   Linux AppImage    -> replaces the AppImage in place, then restarts (main.js)
//   macOS / Linux .deb-> downloads the .dmg/.deb and opens it, you finish the install
//   Android           -> the page sends you to the .apk for your phone; Android installs it
//   npm run web/cli   -> just tells you, with a link

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'MEZTKING/Steam-Master-Idler';
const CHECK_EVERY = 12 * 3_600_000;
const FIRST_CHECK = 60_000;

// "v1.10.2" -> [1, 10, 2]; pre-releases ("1.8.0-beta") count as older than the release
const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
function newer(a, b) {
	const x = parse(a); const y = parse(b);
	for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
	return false;
}

// What kind of install this is, which decides the file and how it's installed
function installKind({ desktop, mobile }) {
	if (mobile) return 'android';
	if (!desktop) return 'none';
	if (process.platform === 'win32') return process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'nsis';
	if (process.platform === 'darwin') return 'dmg';
	if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : 'deb';
	return 'none';
}

const ARCH = {
	x64: ['x64', 'x86_64', 'amd64'],
	arm64: ['arm64', 'aarch64'],
	ia32: ['ia32', 'i386'],
	arm: ['armv7l', 'armhf'],
};

function pickAsset(assets, kind) {
	const has = (a, re) => re.test(a.name);
	const archOk = (a) => (ARCH[process.arch] || [process.arch]).some((x) => a.name.toLowerCase().includes(x));
	switch (kind) {
		case 'nsis': return assets.find((a) => has(a, /setup.*\.exe$/i));
		case 'portable': return assets.find((a) => has(a, /portable.*\.exe$/i));
		case 'dmg': return assets.find((a) => has(a, /\.dmg$/i) && archOk(a)) || assets.find((a) => has(a, /\.dmg$/i));
		case 'appimage': return assets.find((a) => has(a, /\.AppImage$/i) && archOk(a)) || assets.find((a) => has(a, /\.AppImage$/i));
		case 'deb': return assets.find((a) => has(a, /\.deb$/i) && archOk(a)) || assets.find((a) => has(a, /\.deb$/i));
		case 'android': {
			const abi = process.arch === 'arm64' ? 'arm64-v8a' : process.arch === 'arm' ? 'armeabi-v7a' : 'universal';
			return assets.find((a) => a.name.endsWith(`-${abi}.apk`)) || assets.find((a) => a.name.endsWith('-universal.apk'));
		}
		default: return null;
	}
}

function createUpdater({ version, dataDir, desktop, mobile, log, debug, events, getConfig }) {
	const kind = installKind({ desktop, mobile });
	const dir = path.join(dataDir, 'updates');
	const st = { checking: false, checkedAt: null, error: null, latest: null, notes: null, url: null, asset: null, download: null, ready: null };
	let timer = null;
	let announced = null;

	async function check(manual = false) {
		if (st.checking) return;
		st.checking = true;
		try {
			const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
				headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'kettle-updater' },
			});
			if (res.status === 404) throw new Error('No releases published yet.');
			if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
			const rel = await res.json();
			st.checkedAt = Date.now();
			st.error = null;
			if (!newer(rel.tag_name, version)) {
				st.latest = null;
				if (manual) log(`You have the latest version (v${version}).`);
				return;
			}
			const asset = pickAsset(rel.assets || [], kind);
			st.latest = String(rel.tag_name).replace(/^v/, '');
			st.notes = String(rel.body || '').slice(0, 4000);
			st.url = rel.html_url;
			st.asset = asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url, digest: asset.digest || null } : null;
			if (announced !== st.latest) {
				announced = st.latest;
				log(`⬆ Kettle v${st.latest} is available (you have v${version}). Open Settings → Updates, or the banner at the top.`, true);
			}
			if (getConfig().autoUpdate && st.asset && ['nsis', 'appimage'].includes(kind) && !st.ready) download().catch(() => {});
		} catch (err) {
			st.error = err.message;
			debug(`update check failed: ${err.message}`);
			if (manual) throw err;
		} finally {
			st.checking = false;
		}
	}

	async function download() {
		if (!st.asset) throw new Error(kind === 'none' ? 'Update with git pull / npm install when running from source.' : 'No download for this system in the latest release.');
		if (st.download) return;
		if (st.ready?.version === st.latest) return st.ready;
		fs.mkdirSync(dir, { recursive: true });
		for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }   // old downloads
		const file = path.join(dir, st.asset.name);
		const part = `${file}.part`;
		st.download = { done: 0, total: st.asset.size || 0 };
		try {
			const res = await fetch(st.asset.url, { headers: { 'User-Agent': 'kettle-updater' } });
			if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
			const out = fs.createWriteStream(part);
			const hash = crypto.createHash('sha256');
			for await (const chunk of res.body) {
				hash.update(chunk);
				st.download.done += chunk.length;
				if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
			}
			await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
			if (st.asset.size && st.download.done !== st.asset.size) throw new Error('The download was incomplete.');
			if (st.asset.digest?.startsWith('sha256:') && st.asset.digest.slice(7) !== hash.digest('hex')) throw new Error('The download is damaged (checksum mismatch).');
			fs.renameSync(part, file);
			st.ready = { version: st.latest, file };
			log(`⬆ v${st.latest} downloaded${['nsis', 'appimage', 'portable'].includes(kind) ? '. Restart to update.' : '.'}`);
			return st.ready;
		} catch (err) {
			try { fs.unlinkSync(part); } catch {}
			throw err;
		} finally {
			st.download = null;
		}
	}

	// install: downloads if needed, then hands over to main.js (which quits/restarts the app)
	async function install() {
		if (kind === 'android') throw new Error('On Android, open the download link to install.');
		if (kind === 'none') throw new Error('Running from source: update with git pull and npm install.');
		const ready = await download();
		log(`⬆ Installing v${ready.version}…`);
		events.emit('installUpdate', { kind, file: ready.file, version: ready.version });
	}

	function schedule() {
		clearTimeout(timer);
		timer = null;
		if (!getConfig().checkUpdates) return;
		const wait = st.checkedAt ? Math.max(FIRST_CHECK, st.checkedAt + CHECK_EVERY - Date.now()) : FIRST_CHECK;
		timer = setTimeout(() => check().finally(schedule), wait);
	}

	return {
		start: schedule,
		stop: () => clearTimeout(timer),
		schedule,
		check: async () => { await check(true); schedule(); },
		download,
		install,
		snapshot: () => ({
			current: version,
			kind,
			checking: st.checking,
			checkedAt: st.checkedAt,
			error: st.error,
			available: st.latest,
			notes: st.latest ? st.notes : null,
			releaseUrl: st.latest ? st.url : `https://github.com/${REPO}/releases`,
			downloadUrl: st.asset?.url || null,
			size: st.asset?.size || null,
			download: st.download,
			ready: st.ready?.version === st.latest && !!st.latest,
			// how the page should offer it
			action: !st.latest ? null : kind === 'android' ? 'link' : kind === 'none' || !st.asset ? 'page'
				: ['nsis', 'appimage', 'portable'].includes(kind) ? 'install' : 'open',
		}),
	};
}

module.exports = { createUpdater, newer, pickAsset };
