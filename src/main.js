'use strict';

// Desktop app: runs the idler server in-process and shows its page in a window.
// Closing the window keeps idling in the tray; quit from the tray menu.

const path = require('path');
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, powerSaveBlocker } = require('electron');

// one copy at a time - a second launch just focuses the existing window
if (!app.requestSingleInstanceLock()) {
	app.quit();
	return;
}

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
		title: 'Steam Master Idler',
		icon: ICON,
		backgroundColor: '#0f141b',
		autoHideMenuBar: true,
		show: false,
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	win.loadURL(url);
	win.once('ready-to-show', () => {
		if (!process.argv.includes('--hidden')) win.show();
	});

	// links to other sites open in the normal browser
	win.webContents.setWindowOpenHandler(({ url: target }) => {
		if (/^https?:\/\//.test(target)) shell.openExternal(target);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (e, target) => {
		if (!target.startsWith(url)) e.preventDefault();
	});

	// "Save debug report": put it in Downloads and show it in the file manager
	win.webContents.session.on('will-download', (e, item) => {
		item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
		item.once('done', (_, state) => {
			if (state === 'completed') {
				shell.showItemInFolder(item.getSavePath());
				notify(`Debug report saved to ${item.getSavePath()}`);
			}
		});
	});

	// "Minimize to system tray": minimizing or closing hides the window and keeps idling.
	// With it off, minimize works normally and closing the window quits.
	win.on('minimize', (e) => {
		if (!server.getConfig().minimizeToTray) return;
		e.preventDefault();
		win.hide();
	});
	win.on('close', (e) => {
		if (quitting) return;
		if (!server.getConfig().minimizeToTray) return app.quit();
		e.preventDefault();
		win.hide();
		if (!trayHintShown && server.isIdling()) {
			trayHintShown = true;
			notify('Still idling in the background. Use the tray icon to open or quit.');
		}
	});
}

function showWindow() {
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

function notify(body) {
	if (Notification.isSupported()) new Notification({ title: 'Steam Master Idler', body, icon: ICON }).show();
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
		{ label: 'Open Steam Master Idler', click: showWindow },
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
	tray.setToolTip('Steam Master Idler');
	tray.on('click', showWindow);
	buildTrayMenu();
	server.events.on('log', () => {
		tray.setToolTip(server.isIdling() ? 'Steam Master Idler - idling' : 'Steam Master Idler');
	});
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
	server.events.on('session', updateSleepBlocker);
	server.events.on('config', updateSleepBlocker);
	createTray();
	createWindow();
});

// the tray keeps the app alive, so don't quit when the window closes
app.on('window-all-closed', () => {});
