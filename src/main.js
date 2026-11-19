'use strict';

// Desktop app: runs the idler server in-process and shows its page in a window.
// Closing the window keeps idling in the tray; quit from the tray menu.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, powerSaveBlocker, session } = require('electron');

// one copy at a time - a second launch just focuses the existing window
if (!app.requestSingleInstanceLock()) {
	app.quit();
	return;
}

// The app used to be called "Steam Master Idler", and Electron names the data folder after the app.
// On Kettle's first start, move the old folder's data over (settings, sign-in, stats, backups).
function moveOldData() {
	const fs = require('fs');
	const oldDir = path.join(app.getPath('appData'), 'Steam Master Idler');
	const newDir = app.getPath('userData');
	if (path.resolve(oldDir) === path.resolve(newDir) || !fs.existsSync(path.join(oldDir, 'config.json')) || fs.existsSync(path.join(newDir, 'config.json'))) return;
	fs.mkdirSync(newDir, { recursive: true });
	const KEEP = ['config.json', 'state.json', '.session', 'logs', 'steam-user', 'backups', 'screenshot-backups', 'launch-option-backups'];
	for (const name of KEEP) {
		const from = path.join(oldDir, name);
		const to = path.join(newDir, name);
		if (!fs.existsSync(from) || fs.existsSync(to)) continue;
		try {
			fs.renameSync(from, to);
		} catch {
			try { fs.cpSync(from, to, { recursive: true }); } catch { /* leave it where it was */ }
		}
	}
	// paths saved in the settings that pointed into the old folder
	try {
		const f = path.join(newDir, 'config.json');
		const text = fs.readFileSync(f, 'utf8');
		const esc = JSON.stringify(oldDir).slice(1, -1);
		if (text.includes(esc)) fs.writeFileSync(f, text.split(esc).join(JSON.stringify(newDir).slice(1, -1)));
	} catch { /* fine */ }
}
try { moveOldData(); } catch (err) { console.error('moving old data failed:', err); }

// keep config / login / state in the per-user app data folder, not the install folder
process.env.IDLER_DATA_DIR = app.getPath('userData');
process.env.IDLER_DESKTOP = '1';   // shows the desktop-only settings in the page
const server = require('./server');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'assets', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');

let win = null;
let tray = null;
let url = null;
let quitting = false;
let trayHintShown = false;

function createWindow() {
	win = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 420,
		minHeight: 500,
		title: 'Kettle',
		icon: ICON,
		backgroundColor: '#0f141b',
		autoHideMenuBar: true,
		show: false,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	win.loadURL(url);
	win.once('ready-to-show', () => win.show());
	win.on('closed', () => { win = null; });

	// links to other sites open in the normal browser
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		if (/^https?:\/\//.test(target)) shell.openExternal(target);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (e, target) => {
		if (!target.startsWith(url)) e.preventDefault();
	});

	// "Minimize to system tray": minimizing or closing hides the window and keeps idling.
	// With it off, minimize works normally and closing the window quits.
	win.on('minimize', (e) => {
		if (!server.getConfig().minimizeToTray) return;
		e.preventDefault();
		toTray();
	});
	win.on('close', (e) => {
		if (quitting) return;
		if (!server.getConfig().minimizeToTray) return app.quit();
		e.preventDefault();
		toTray();
		if (!trayHintShown && server.isIdling()) {
			trayHintShown = true;
			notify('Still idling in the background. Use the tray icon to open or quit.');
		}
	});
}

// "Free memory while in the tray": close the window completely (its page is what uses the memory);
// everything keeps running, and the tray icon builds a new window in about a second
function toTray() {
	if (!win) return;
	if (server.getConfig().freeMemoryInTray) setImmediate(() => { if (win) win.destroy(); });
	else win.hide();
}

function showWindow() {
	if (!url) return;
	if (!win) return createWindow();
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

function notify(body) {
	if (Notification.isSupported()) new Notification({ title: 'Kettle', body, icon: ICON }).show();
}

// "Prevent sleep": keep the computer awake while idling
let sleepBlocker = null;
function updateSleepBlocker() {
	const want = server.isIdling() && server.getConfig().preventSleep;
	if (want && sleepBlocker == null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
	if (!want && sleepBlocker != null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
}

function buildTrayMenu() {
	const startAtLogin = app.getLoginItemSettings().openAtLogin;
	tray.setContextMenu(Menu.buildFromTemplate([
		{ label: 'Open Kettle', click: showWindow },
		{ type: 'separator' },
		{
			label: 'Start when I log in',
			type: 'checkbox',
			checked: startAtLogin,
			visible: process.platform !== 'linux',
			click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
		},
		{ label: 'Open data folder', click: () => shell.openPath(server.DATA_DIR) },
		{ label: 'Open logs folder', click: () => shell.openPath(require('path').join(server.DATA_DIR, 'logs')) },
		{ type: 'separator' },
		{ label: 'Quit', click: () => app.quit() },
	]));
}

function createTray() {
	tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
	tray.setToolTip('Kettle');
	tray.on('click', showWindow);
	buildTrayMenu();
	server.events.on('log', () => {
		tray.setToolTip(server.isIdling() ? 'Kettle - idling' : 'Kettle');
	});
}

// In-app update (see lib/updater.js): the file is downloaded and checked; put it in place and restart.
// macOS .dmg / Linux .deb: opened for you to finish (unsigned apps can't replace themselves there).
async function installUpdate({ kind, file, version }) {
	try {
		if (kind === 'dmg' || kind === 'deb') {
			const err = await shell.openPath(file);
			if (err) throw new Error(err);
			notify(`Version ${version} downloaded. Finish installing it in the window that opened, then restart the app.`);
			return;
		}
		let relaunch = null;
		if (kind === 'portable') {
			// the running .exe can't be overwritten: put the new one next to it and start that
			const dest = path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), path.basename(file));
			fs.copyFileSync(file, dest);
			relaunch = dest;
		} else if (kind === 'appimage') {
			const target = process.env.APPIMAGE;
			fs.copyFileSync(file, `${target}.new`);
			fs.chmodSync(`${target}.new`, 0o755);
			fs.renameSync(`${target}.new`, target);   // fine while running on Linux
			relaunch = target;
		} else if (kind !== 'nsis') {
			throw new Error(`can't install updates for ${kind}`);
		}
		quitting = true;
		await server.stop();   // stop idling and log off cleanly first
		if (kind === 'nsis') {
			// silent install into the same folder; --force-run starts the new version afterwards
			spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
		} else {
			app.relaunch({ execPath: relaunch, args: [] });
		}
		app.exit(0);
	} catch (err) {
		notify(`Couldn't install the update: ${err.message}`);
	}
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);   // macOS dock click

app.on('before-quit', async (e) => {
	if (quitting) return;
	quitting = true;
	e.preventDefault();
	await server.stop();   // stop "playing" and log off Steam cleanly
	app.quit();
});

app.whenReady().then(async () => {
	if (process.platform === 'win32') app.setAppUserModelId('com.meztking.steammasteridler');
	url = await server.start(0);   // any free local port
	server.events.on('notify', notify);
	server.events.on('openPath', (dir) => shell.openPath(dir));
	server.events.on('installUpdate', installUpdate);
	// restored settings: restart to load them
	server.events.on('restart', async () => { quitting = true; await server.stop(); app.relaunch(); app.exit(0); });
	server.events.on('session', updateSleepBlocker);
	server.events.on('config', updateSleepBlocker);
	// "Save debug report": put it in Downloads and show it in the file manager
	session.defaultSession.on('will-download', (e, item) => {
		item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
		item.once('done', (_, state) => {
			if (state === 'completed') {
				shell.showItemInFolder(item.getSavePath());
				notify(`Debug report saved to ${item.getSavePath()}`);
			}
		});
	});
	createTray();
	// started hidden at login: don't build the window until it's opened from the tray
	if (!process.argv.includes('--hidden')) createWindow();
});

// the tray keeps the app alive, so don't quit when the window closes
app.on('window-all-closed', () => {});
