'use strict';

// Android entry point, started by the app's native code (android/):
//   node mobile.js <data dir>
// Runs the same server as the desktop app; the app's WebView shows its page. The URL is written to
// <data dir>/server-url.txt so the Android side knows which port to open.

const fs = require('fs');
const path = require('path');

const dataDir = process.argv[2];
process.env.IDLER_DATA_DIR = dataDir;
process.env.IDLER_MOBILE = '1';

const server = require('./server');

server.start(0).then((url) => {
	fs.writeFileSync(path.join(dataDir, 'server-url.txt'), url);
}).catch((err) => {
	console.error('server failed to start:', err);
	process.exit(1);
});
