'use strict';

// Renders every icon PNG from assets/src/icon.svg:  npm run icons
// Needs Playwright with Chromium (npx playwright install chromium).

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(ROOT, 'assets', 'src', 'icon.svg'), 'utf8');
// macOS menu bar: just the kettle, black on transparent (macOS tints it)
const template = svg
	.replace(/<rect x="2"[^>]*\/>/g, '')
	.replace(/<g id="kettle" fill="#fff" stroke="#fff"/, '<g id="kettle" fill="#000" stroke="#000" transform="translate(-8 -4) scale(1.12)"');

const OUT = [
	['assets/icon.png', 1024, svg],
	['assets/tray.png', 32, svg],
	['assets/tray@2x.png', 64, svg],
	['assets/trayTemplate.png', 16, template],
	['assets/trayTemplate@2x.png', 32, template],
	['android/app/src/main/res/mipmap-mdpi/ic_launcher.png', 48, svg],
	['android/app/src/main/res/mipmap-hdpi/ic_launcher.png', 72, svg],
	['android/app/src/main/res/mipmap-xhdpi/ic_launcher.png', 96, svg],
	['android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png', 144, svg],
	['android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', 192, svg],
];

(async () => {
	const browser = await chromium.launch();
	for (const [file, size, source] of OUT) {
		const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
		await page.setContent(`<html><body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}"></body></html>`);
		await page.waitForFunction(() => document.images[0].complete);
		await page.screenshot({ path: path.join(ROOT, file), omitBackground: true });
		await page.close();
		console.log(`${file} (${size}×${size})`);
	}
	await browser.close();
})();
