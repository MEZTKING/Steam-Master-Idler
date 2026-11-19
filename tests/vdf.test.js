'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { getVdfValue, getVdfBlock, setVdfValue } = require('../src/lib/vdf-edit');
const { parseVdf, vdfGet } = require('../src/lib/vdf');

const APPS = ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'];
const LOCALCONFIG = '"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n\t\t\t\t\t"730"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1700000000"\n\t\t\t\t\t\t"LaunchOptions"\t\t"-novid \\"x\\""\n\t\t\t\t\t}\n\t\t\t\t\t"440"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"1"\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t\t"other"\t\t"keep me"\n\t\t\t}\n\t\t}\n\t}\n\t"dup"\t"1"\n\t"dup"\t"2"\n}\n';

test('reads values, with escaped quotes', () => {
	assert.strictEqual(getVdfValue(LOCALCONFIG, [...APPS, '730'], 'LaunchOptions'), '-novid "x"');
	assert.strictEqual(getVdfValue(LOCALCONFIG, [...APPS, '730'], 'launchoptions'), '-novid "x"', 'keys ignore case');
	assert.strictEqual(getVdfValue(LOCALCONFIG, [...APPS, '440'], 'LaunchOptions'), undefined);
	assert.deepStrictEqual(Object.keys(getVdfBlock(LOCALCONFIG, APPS)).sort(), ['440', '730']);
});

test('changes only the one value and keeps the rest byte for byte', () => {
	const out = setVdfValue(LOCALCONFIG, [...APPS, '730'], 'LaunchOptions', '-high %command% "q"');
	assert.strictEqual(getVdfValue(out, [...APPS, '730'], 'LaunchOptions'), '-high %command% "q"');
	const before = LOCALCONFIG.split('"LaunchOptions"');
	const after = out.split('"LaunchOptions"');
	assert.strictEqual(after[0], before[0]);
	assert.strictEqual(after[1].slice(after[1].indexOf('\n')), before[1].slice(before[1].indexOf('\n')));
	assert.strictEqual((out.match(/"dup"/g) || []).length, 2, 'duplicate keys kept');
});

test('adds the value to an existing game, and creates a missing game block', () => {
	let out = setVdfValue(LOCALCONFIG, [...APPS, '440'], 'LaunchOptions', '-dx11');
	out = setVdfValue(out, [...APPS, '570'], 'LaunchOptions', '-novid');
	assert.strictEqual(getVdfValue(out, [...APPS, '440'], 'LaunchOptions'), '-dx11');
	assert.strictEqual(getVdfValue(out, [...APPS, '570'], 'LaunchOptions'), '-novid');
	assert.match(out, /\n\t\t\t\t\t"570"\n\t\t\t\t\t\{\n\t\t\t\t\t\t"LaunchOptions"\t\t"-novid"\n\t\t\t\t\t\}\n/, "Steam's indentation");
	assert.strictEqual(getVdfValue(out, [...APPS, '730'], 'LastPlayed'), '1700000000');
	assert.ok(out.includes('"other"\t\t"keep me"'));
});

test('keeps Windows line endings', () => {
	const crlf = LOCALCONFIG.replace(/\n/g, '\r\n');
	const out = setVdfValue(crlf, [...APPS, '570'], 'LaunchOptions', '-x');
	assert.ok(!/[^\r]\n/.test(out), 'no bare \\n added');
});

test('the KeyValues reader', () => {
	const v = parseVdf('"Registry" { "HKCU" { "Software" { "Valve" { "Steam" { "RunningAppID" "730" } } } } } // comment');
	assert.strictEqual(vdfGet(v, 'registry', 'hkcu', 'software', 'valve', 'steam', 'runningappid'), '730');
});
