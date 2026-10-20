'use strict';

// Password-less login: show a QR code, scan it in the Steam mobile app, get a refresh token.

const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

// Calls onQr(url) with the QR contents (again whenever Steam rotates it) and onScanned()
// once the code is scanned. Resolves with a refresh token for steam-user's logOn().
function startQrLogin({ onQr, onScanned, timeoutMs = 3 * 60_000 }) {
	const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
	session.loginTimeout = timeoutMs;

	const done = new Promise((resolve, reject) => {
		session.on('remoteInteraction', () => onScanned?.());
		session.on('debug', (msg, data) => {
			if (msg === 'poll response' && data?.newChallengeUrl) onQr(data.newChallengeUrl);
		});
		session.on('authenticated', () => resolve({ refreshToken: session.refreshToken, accountName: session.accountName }));
		session.on('timeout', () => reject(new Error('QR code expired')));
		session.on('error', reject);
	});

	const started = session.startWithQR().then((r) => onQr(r.qrChallengeUrl));
	return {
		done: started.then(() => done),
		cancel: () => session.cancelLoginAttempt(),
	};
}

module.exports = { startQrLogin };
