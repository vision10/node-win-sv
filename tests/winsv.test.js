'use strict';

// How the package talks to winsv, the bundled wrapper: one command installs and starts, and the password
// travels on the standard input. Another wrapper is driven like WinSW.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Service = require('../lib/service');
const winsw = require('../lib/winsw');
const cmd = require('../lib/cmd');
const { script, tmpDir, tag } = require('./helpers');

function recorded(t, config) {
  const dir = tmpDir(t);
  const wrapperExe = path.join(dir, 'winsv.exe');
  fs.writeFileSync(wrapperExe, 'stands for winsv, which is known by its option --password-stdin');
  const svc = new Service({ id: 'svc', script, winswDest: dir, wrapperExe, ...config });
  const calls = [];
  t.mock.method(cmd, 'run', async (file, args, options) => {
    calls.push(options.input === undefined ? args : [...args, { input: options.input }]);
    return 'done';
  });
  const events = [];
  for (const name of ['install', 'start']) { svc.on(name, () => events.push(name)) }
  return { svc, calls, events };
}

test('the bundled wrapper is winsv, another executable is driven like WinSW', t => {
  assert.equal(winsw.wrapperExe({}), process.env.WIN_SV_EXE ? path.resolve(process.env.WIN_SV_EXE) : winsw.WINSV_EXE);
  assert.equal(winsw.isWinSW(winsw.WINSV_EXE), false);
  const other = path.join(tmpDir(t), 'other.exe');
  fs.writeFileSync(other, 'another wrapper');
  assert.equal(winsw.isWinSW(other), true);
});

test('a service that still runs a copy of WinSW is driven like WinSW until the copy is replaced', async t => {
  const { svc, calls } = recorded(t, { logOnAs: { account: 'corp\\bob', password: 'secret' } });
  fs.mkdirSync(svc.winswPath, { recursive: true });
  fs.writeFileSync(svc.exePath, 'the copy of WinSW made by an older version');
  await svc.install();
  await svc.install({ overwrite: true });
  assert.deepEqual(calls, [
    ['install', '--username', 'corp\\bob', '--password', 'secret'],
    ['install', '--username', 'corp\\bob', '--password-stdin', { input: 'secret\n' }],
  ]);
});

test('the password is given on the standard input, never on the command line', async t => {
  const { svc, calls } = recorded(t, { logOnAs: { account: 'corp\\bob', password: 'S3cret & <sharp>' } });
  await svc.install();
  await svc.install({ user: 'corp\\alice', password: '', noElevate: true });
  assert.deepEqual(calls, [
    ['install', '--username', 'corp\\bob', '--password-stdin', { input: 'S3cret & <sharp>\n' }],
    ['install', '--no-elevate', '--username', 'corp\\alice', '--password-stdin', { input: '\n' }],
  ]);
  assert.ok(!fs.readFileSync(svc.xmlPath, 'utf8').includes('S3cret'));
});

test('install and start are one command', async t => {
  const { svc, calls, events } = recorded(t);
  assert.equal(await svc.install({ start: true }), 'done');
  await svc.install();
  assert.deepEqual(calls, [['install', '--start'], ['install']]);
  assert.deepEqual(events, ['install', 'start', 'install']);
});

test('the options only winsv understands are written to the file', t => {
  const xml = winsw.generateXml({
    id: 'svc', script, keepDetached: true,
    log: { mode: 'roll-by-time', keepFiles: 7, combine: true, timestamp: 'HH:mm:ss', rollOnStart: true, wrapper: false },
  });
  for (const [name, value] of [['keepDetached', 'true'], ['keepFiles', '7'], ['combine', 'true'], ['timestamp', 'HH:mm:ss'], ['rollOnStart', 'true'], ['wrapper', 'false']]) {
    assert.equal(tag(xml, name), value, name);
  }
  const plain = winsw.generateXml({ id: 'svc', script, log: 'append' });
  assert.ok(!/keepDetached|combine|timestamp|rollOnStart|<wrapper>/.test(plain));
});
