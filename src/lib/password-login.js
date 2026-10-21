'use strict';

// Username + password login that keeps the attempt open while Steam waits for the second step, so
// the Steam mobile app gets a "Confirm sign in" request you can approve. (steam-user's built-in
// password login cancels the attempt right away and only accepts a typed code.) A code from the
// Steam app's Steam Guard tab or from an email works too.

const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType, EResult } = require('steam-session');

const MESSAGES = {
	[EResult.InvalidPassword]: 'Wrong username or password.',
	[EResult.RateLimitExceeded]: 'Too many sign-in attempts. Wait a while, then try again.',
	[EResult.AccountLoginDeniedThrottle]: 'Too many sign-in attempts. Wait a while, then try again.',
	[EResult.InvalidLoginAuthCode]: 'That code was wrong.',
	[EResult.TwoFactorCodeMismatch]: 'That code was wrong.',
	[EResult.Expired]: 'That code has expired.',
};
const friendly = (err) => new Error(MESSAGES[err.eresult] || err.message);

// onGuard({ approve, appCode, emailCode, emailDomain }) is called when Steam needs a second step.
// Resolves `done` with { refreshToken, accountName } once signed in.
function startPasswordLogin({ accountName, password, onGuard, timeoutMs = 5 * 60_000 }) {
	const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
	session.loginTimeout = timeoutMs;

	const done = new Promise((resolve, reject) => {
		session.on('authenticated', () => resolve({ refreshToken: session.refreshToken, accountName: session.accountName }));
		session.on('timeout', () => reject(new Error('The sign-in request expired. Try again.')));
		session.on('error', (err) => reject(friendly(err)));

		session.startWithCredentials({ accountName, password }).then((result) => {
			if (!result.actionRequired) return;   // no Steam Guard: 'authenticated' follows
			const has = (type) => result.validActions.find((a) => a.type === type);
			const email = has(EAuthSessionGuardType.EmailCode);
			onGuard({
				approve: !!(has(EAuthSessionGuardType.DeviceConfirmation) || has(EAuthSessionGuardType.EmailConfirmation)),
				appCode: !!has(EAuthSessionGuardType.DeviceCode),
				emailCode: !!email,
				emailDomain: email?.detail || null,
			});
		}).catch((err) => reject(friendly(err)));
	});

	return {
		done,
		// throws a friendly error for a wrong/expired code; the attempt stays open to try again
		submitCode: (code) => session.submitSteamGuardCode(code).catch((err) => { throw friendly(err); }),
		cancel: () => session.cancelLoginAttempt(),
	};
}

module.exports = { startPasswordLogin };
