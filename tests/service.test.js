'use strict';

// The Service class. WinSW is either asked read-only questions or replaced by a stub,
// so nothing is installed and no administrator rights are needed. See integration.js for the real thing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Service, cmd } = require('../index');
const winsw = require('../lib/winsw');
const { script, tmpDir, tag, wrapper, isWinSW } = require('./helpers');

/** A service with its files on disk and WinSW replaced by `answer(command, args)`. */
function stubbed(t, config, answer) {
  const svc = new Service({ id: 'svc', script, winswDest: tmpDir(t), ...config });
  winsw.createFiles(svc.winswPath, svc.config);
  const calls = [];
  // as an administrator every command goes straight to the wrapper, elevation.test.js covers the other case
  t.mock.method(cmd, 'isElevated', async () => true);
  t.mock.method(cmd, 'run', async (file, args, options) => {
    calls.push(args.join(' '));
    assert.equal(file, svc.exePath);
    assert.equal(options.cwd, svc.winswPath);
    return answer ? answer(args[0], args.slice(1)) : args[0] + ' done';
  });
  return { svc, calls };
}

function exitCode(code, stdout) {
  return Object.assign(new Error(stdout || 'failed'), { code, stdout: stdout || '', stderr: '' });
}

test('id and script are required', () => {
  assert.throws(() => new Service(), /required/);
  assert.throws(() => new Service({ id: 'svc' }), /required/);
  assert.throws(() => new Service({ script }), /required/);
  assert.equal(new Service({ name: 'only a name', script }).id, 'only a name');
  assert.equal(new Service({ id: 'svc', execPath: 'C:\\tools\\app.exe' }).id, 'svc');
});

test('the configuration is copied', () => {
  const config = { id: 'svc', script };
  const svc = new Service(config);
  config.id = 'changed';
  assert.equal(svc.id, 'svc');
  assert.equal(svc.name, 'svc');
  assert.equal(new Service({ id: 'svc', name: 'Display name', script }).name, 'Display name');
});

test('wrapper folder defaults to "daemon" next to the script', () => {
  const svc = new Service({ id: 'svc', script });
  assert.equal(svc.winswPath, path.join(path.dirname(script), 'daemon'));
  assert.equal(svc.exePath, path.join(path.dirname(script), 'daemon', 'svc.exe'));
  assert.equal(svc.xmlPath, path.join(path.dirname(script), 'daemon', 'svc.xml'));
  assert.equal(svc.exists, false);
});

test('wrapper folder can be moved and renamed', () => {
  const custom = new Service({ name: 'svc 2', script, winswDest: os.tmpdir(), winswDir: 'wrapper' });
  assert.equal(custom.xmlPath, path.join(os.tmpdir(), 'wrapper', 'svc 2.xml'));
  const legacy = new Service({ id: 'svc', script, winswDest: os.tmpdir(), winswDirname: 'legacy' });
  assert.equal(legacy.winswPath, path.join(os.tmpdir(), 'legacy'));
  const relative = new Service({ id: 'svc', script: 'app/server.js' });
  assert.equal(relative.winswPath, path.resolve('app', 'daemon'));
});

test('a service that was never installed', async t => {
  const svc = new Service({ id: 'svc', script, winswDest: tmpDir(t) });
  const events = [];
  svc.on('status', status => events.push(status));
  svc.on('invalidinstallation', error => events.push(error.message));

  assert.equal(await svc.status(), 'NonExistent');
  assert.equal(await svc.isInstalled(), false);
  assert.equal(await svc.isRunning(), false);
  await assert.rejects(svc.start(), /executable cannot be found/);
  await assert.rejects(svc.stop(), /cannot be found/);
  await assert.rejects(svc.refresh({ description: 'x' }), /cannot be found/);
  assert.equal(await svc.uninstall(true), '');
  assert.equal(events.filter(event => event === 'NonExistent').length, 3);
  assert.equal(events.filter(event => /cannot be found/.test(event)).length, 3);
});

test('a missing configuration file is reported', async t => {
  const { svc } = stubbed(t);
  fs.rmSync(svc.xmlPath);
  assert.equal(svc.exists, false);
  await assert.rejects(svc.restart(), /configuration file cannot be found/);
});

test('generated files are accepted by WinSW', async t => {
  // WinSW parses the configuration to answer `status`, so this validates the file with the real executable
  const svc = new Service({
    id: 'win-sv-unit-' + process.pid, name: 'win-sv unit test', description: 'never installed & <escaped>',
    script, winswDest: tmpDir(t), scriptOptions: ['a b', '--flag'], env: { PORT: '3999', TEXT: 'a "quoted" value' },
    depend: ['Eventlog'], onfailure: [{ action: 'restart', delay: 5 }, 'none'], resetfailure: '1 hour',
    log: { mode: 'roll-by-size-time', autoRollAtTime: '00:00:00' }, logOnAs: 'LocalService',
    startmode: 'manual', priority: 'belownormal', stoptimeout: 10, delayedAutoStart: true,
    prestart: { executable: 'cmd', arguments: ['/c', 'echo hi'] },
    download: { from: 'https://example.com/a.dat', to: '%BASE%\\a.dat' },
  });
  const files = winsw.createFiles(svc.winswPath, svc.config);
  assert.deepEqual(files, { exe: svc.exePath, xml: svc.xmlPath });
  assert.equal(svc.exists, true);
  assert.equal(await svc.status(), 'NonExistent');
  assert.equal(await svc.isInstalled(), false);
});

test('WinSW rejects a broken configuration file', async t => {
  const svc = new Service({ id: 'win-sv-unit-' + process.pid, script, winswDest: tmpDir(t) });
  winsw.createFiles(svc.winswPath, svc.config);
  fs.writeFileSync(svc.xmlPath, '<service><id>broken</service>');
  await assert.rejects(svc.status());
});

test('starting without administrator rights fails when elevation is refused', async t => {
  if (await cmd.isElevated()) { return t.skip('running elevated') }
  const svc = new Service({ id: 'win-sv-unit-' + process.pid, script, winswDest: tmpDir(t) });
  winsw.createFiles(svc.winswPath, svc.config);
  await assert.rejects(svc.start(true), error => {
    assert.equal(error.code, 5);
    assert.match(error.message, /denied/i);
    return true;
  });
});

test('a custom wrapper executable', t => {
  const dir = tmpDir(t);
  const custom = path.join(dir, 'custom.exe');
  fs.writeFileSync(custom, 'not really an executable');
  const svc = new Service({ id: 'svc', script, winswDest: dir, wrapperExe: custom });
  winsw.createFiles(svc.winswPath, svc.config);
  assert.equal(fs.readFileSync(svc.exePath, 'utf8'), 'not really an executable');
  assert.throws(() => winsw.createFiles(dir, { id: 'svc', script, wrapperExe: path.join(dir, 'missing.exe') }), /not found/);
});

test('command flags', async t => {
  const { svc, calls } = stubbed(t);
  assert.equal(await svc.start(), 'start done');
  await svc.start(true, true);
  await svc.stop();
  await svc.stop(true, true, true);
  await svc.restart();
  await svc.restart(true, true);
  await svc.selfRestart();
  assert.deepEqual(calls, [
    'start',
    'start --no-elevate --no-wait',
    'stop',
    'stop --no-elevate --no-wait --force',
    'restart',
    'restart --no-elevate --force',
    'restart!',
  ]);
});

test('events carry the command output', async t => {
  const { svc } = stubbed(t, {}, command => (command === 'status' ? 'Active (running)' : command + ' output'));
  const events = [];
  for (const name of ['install', 'start', 'stop', 'restart', 'status', 'refresh', 'uninstall']) {
    svc.on(name, output => events.push(`${name}: ${output}`));
  }
  await svc.install();
  await svc.start();
  await svc.status();
  await svc.restart();
  await svc.selfRestart();
  await svc.refresh();
  await svc.stop();
  assert.deepEqual(events, [
    'install: install output',
    'start: start output',
    'status: Active (running)',
    'restart: restart output',
    'restart: restart! output',
    'refresh: refresh output',
    'stop: stop output',
  ]);
});

test('status is read from the output even though WinSW exits with a code', async t => {
  let failure;
  const { svc } = stubbed(t, {}, () => { throw failure });

  failure = exitCode(1, 'Active (running)');
  assert.equal(await svc.status(), 'Active (running)');
  assert.equal(await svc.isRunning(), true);
  assert.equal(await svc.isInstalled(), true);

  failure = exitCode(1, 'Active (stopping)');
  assert.equal(await svc.isRunning(), true);

  failure = exitCode(1060, 'NonExistent');
  assert.equal(await svc.status(), 'NonExistent');
  assert.equal(await svc.isInstalled(), false);

  failure = exitCode(-1, 'The configuration file could not be loaded.');
  await assert.rejects(svc.status(), /could not be loaded/);
  failure = exitCode(1);
  await assert.rejects(svc.status(), /failed/);
});

test('a failing command rejects and emits nothing', async t => {
  const { svc } = stubbed(t, {}, () => { throw exitCode(5, 'Access is denied') });
  svc.on('start', () => assert.fail('start must not be emitted'));
  await assert.rejects(svc.start(), error => error.code === 5 && /denied/.test(error.message));
});

test('install writes the files and passes the account', async t => {
  const dest = tmpDir(t);
  const svc = new Service({ id: 'svc', script, winswDest: dest, description: 'first' });
  const calls = [];
  t.mock.method(cmd, 'run', async (file, args) => { calls.push(args); return 'ok' });

  assert.equal(await svc.install(), 'ok');
  assert.equal(svc.exists, true);
  assert.equal(fs.statSync(svc.exePath).size, fs.statSync(wrapper).size);
  assert.equal(fs.readFileSync(svc.xmlPath)[0], 0xEF, 'the file starts with a UTF-8 byte order mark');
  assert.equal(tag(fs.readFileSync(svc.xmlPath, 'utf8'), 'description'), 'first');

  await svc.install({ noElevate: true, user: 'corp\\bob', pass: 'secret' });
  await svc.install({ username: 'bob', password: 'two words' });
  await svc.install({ user: 'gmsa$' });
  await svc.install({ start: true, noElevate: true });
  assert.deepEqual(calls, [
    ['install'],
    ['install', '--no-elevate', '--username', 'corp\\bob', '--password', 'secret'],
    ['install', '--username', 'bob', '--password', 'two words'],
    ['install'],
    ['install', '--no-elevate'],
    ['start', '--no-elevate'],
  ]);
});

test('install refreshes the configuration but keeps the executable unless asked', async t => {
  const { svc } = stubbed(t);
  fs.writeFileSync(svc.exePath, 'old wrapper');
  svc.config.description = 'second';

  await svc.install();
  assert.equal(tag(fs.readFileSync(svc.xmlPath, 'utf8'), 'description'), 'second');
  assert.equal(fs.readFileSync(svc.exePath, 'utf8'), 'old wrapper');

  await svc.install({ overwrite: true });
  assert.equal(fs.statSync(svc.exePath).size, fs.statSync(wrapper).size);
});

test('install fails before touching anything when the configuration is invalid', async t => {
  const svc = new Service({ id: 'svc', script, winswDest: tmpDir(t), priority: 'fastest' });
  t.mock.method(cmd, 'run', async () => assert.fail('WinSW must not be called'));
  await assert.rejects(svc.install(), /priority/);
  assert.equal(fs.existsSync(svc.winswPath), false);
});

test('refresh writes the changed options first', async t => {
  const { svc, calls } = stubbed(t, { description: 'before' });
  await svc.refresh({ description: 'after', startmode: 'manual' }, true);
  const xml = fs.readFileSync(svc.xmlPath, 'utf8');
  assert.equal(tag(xml, 'description'), 'after');
  assert.equal(tag(xml, 'startmode'), 'manual');
  assert.equal(svc.config.description, 'after');
  assert.deepEqual(calls, ['refresh --no-elevate']);
});

test('refresh refuses a new id and leaves an invalid change unwritten', async t => {
  const { svc, calls } = stubbed(t, { description: 'before' });
  await assert.rejects(svc.refresh({ id: 'other' }), /id cannot be changed/);
  await assert.rejects(svc.refresh({ startmode: 'sometimes' }), /startmode/);
  assert.equal(tag(fs.readFileSync(svc.xmlPath, 'utf8'), 'description'), 'before');
  assert.equal(svc.config.startmode, undefined);
  assert.deepEqual(calls, []);
});

test('uninstall stops a running service first', async t => {
  const { svc, calls } = stubbed(t, {}, command => (command === 'status' ? 'Active (running)' : ''));
  const events = [];
  for (const name of ['status', 'stop', 'uninstall']) { svc.on(name, () => events.push(name)) }

  await svc.uninstall({ force: true, noElevate: true, noWait: true });
  assert.deepEqual(calls, ['status', 'stop --no-elevate --no-wait --force', 'uninstall --no-elevate']);
  assert.deepEqual(events, ['stop', 'uninstall']);
  assert.equal(svc.exists, true, 'files are kept unless removeFiles is set');
});

test('uninstall does not stop a stopped service', async t => {
  const stopped = stubbed(t, {}, command => (command === 'status' ? 'Inactive (stopped)' : 'removed'));
  assert.equal(await stopped.svc.uninstall(), 'removed');
  assert.deepEqual(stopped.calls, ['status', 'uninstall']);
});

test('uninstall of an unregistered service only cleans up', async t => {
  const missing = stubbed(t, {}, () => { throw exitCode(1060, 'NonExistent') });
  assert.equal(await missing.svc.uninstall(true), '');
  assert.deepEqual(missing.calls, ['status']);
  assert.equal(fs.existsSync(missing.svc.winswPath), false, 'leftover files are still removed');
});

test('uninstall keeps the positional arguments of 0.x', async t => {
  const { svc, calls } = stubbed(t, {}, command => (command === 'status' ? 'Active (running)' : ''));
  fs.writeFileSync(path.join(svc.winswPath, 'svc.out.log'), 'output');
  await svc.uninstall(true, true, false, true);
  assert.deepEqual(calls, ['status', 'stop --no-wait --force', 'uninstall']);
  assert.equal(fs.existsSync(svc.winswPath), false);
});

test('a failed stop aborts the uninstall', async t => {
  const { svc, calls } = stubbed(t, {}, command => {
    if (command === 'status') { return 'Active (running)' }
    throw exitCode(1051, 'A stop control has been sent to a service that other running services are dependent on.');
  });
  await assert.rejects(svc.uninstall(true), /dependent/);
  assert.deepEqual(calls, ['status', 'stop']);
  assert.equal(svc.exists, true);
});

test('customize', async t => {
  const dir = tmpDir(t);
  const svc = new Service({ id: 'svc', script, winswDest: dir });
  const calls = [];
  t.mock.method(cmd, 'run', async (file, args) => { calls.push([path.basename(file), ...args]); return '' });
  const output = path.join(dir, 'branded.exe');

  await assert.rejects(svc.customize(), /output is required/);
  // limits enforced by WinSW
  await assert.rejects(svc.customize(output), /manufacturer is required/);
  await assert.rejects(svc.customize(output, 'ACME Inc.'), /12 to 15/);
  await assert.rejects(svc.customize(output, 'ACME Incorporated'), /12 to 15/);
  assert.deepEqual(calls, []);

  let emitted = 0;
  svc.on('customize', () => emitted++);
  await svc.customize(output, 'ACME Company');
  winsw.createFiles(svc.winswPath, svc.config);
  await svc.customize('relative.exe', 'ACME Company');
  assert.deepEqual(calls, [
    [path.basename(wrapper), 'customize', '--output', output, '--manufacturer', 'ACME Company'],
    ['svc.exe', 'customize', '--output', path.resolve('relative.exe'), '--manufacturer', 'ACME Company'],
  ]);
  assert.equal(emitted, 2);
});

test('customize writes a working copy of the wrapper', async t => {
  if (!isWinSW) { return t.skip('specific to WinSW') }
  const dir = tmpDir(t);
  const output = path.join(dir, 'branded.exe');
  await new Service({ id: 'svc', script, winswDest: dir }).customize(output, 'ACME Company');
  assert.ok(fs.statSync(output).size > 100000);
  assert.match(await cmd.run(output, ['--version']), /^3\./);
});

test('removeFiles only touches files of that service', t => {
  const dir = tmpDir(t);
  const keep = ['app2.xml', 'app.js', 'app.json', 'notes.txt', 'other.out.log'];
  const drop = ['app.xml', 'app.exe', 'APP.exe.config', 'app.out.log', 'app.err.log', 'app.wrapper.log', 'app.1.out.log', 'app.20240101.err.log', 'app.out.log.old'];
  keep.concat(drop).forEach(file => fs.writeFileSync(path.join(dir, file), ''));
  winsw.removeFiles(dir, 'app');
  assert.deepEqual(fs.readdirSync(dir).sort(), keep.sort());

  winsw.removeFiles(dir, 'app2');
  winsw.removeFiles(dir, 'other');
  assert.equal(fs.existsSync(dir), true, 'a folder with other files is kept');
  winsw.removeFiles(path.join(dir, 'missing'), 'app');
});

test('removeFiles deletes the folder once empty', t => {
  const dir = path.join(tmpDir(t), 'daemon');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'a.b.xml'), '');
  winsw.removeFiles(dir, 'a.b');
  assert.equal(fs.existsSync(dir), false);
});
