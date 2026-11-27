'use strict';

// The package end to end, on real services: the Service class, the command line, services and
// processes by name, and the event log. Also a complete example of how the package is used.
//
// Needs administrator rights (tests/acceptance/run.js asks for them once). The tests run in order
// and build on each other.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const win = require('../../index');
const { script, waitFor, exec, ask, server, tmpDir, removeDir } = require('./helpers');

const PORT = 39417;
const SOURCE = 'win-sv acceptance test';
const SOURCE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\' + SOURCE;
const cli = path.join(__dirname, '..', '..', 'bin', 'cli.js');
const dest = tmpDir();
const stopFile = path.join(dest, 'stopped.txt');

const svc = new win.Service({
  id: 'win-sv-acceptance',
  name: 'win-sv acceptance test',
  description: 'Temporary service created by the win-sv tests',
  script,
  scriptOptions: ['hello world', '--flag=1'],
  env: { PORT, WINSV_GREETING: 'hi & <bye>', WINSV_STOP_FILE: stopFile },
  winswDest: dest,
  startmode: 'manual',
  stoptimeout: 10,
  resetfailure: 60,
  onfailure: [{ action: 'restart', delay: 1 }],
});

const events = [];
for (const name of ['install', 'start', 'stop', 'restart', 'refresh', 'uninstall']) {
  svc.on(name, () => events.push(name));
}

const runCli = args => exec(process.execPath, [cli, ...args]);
const cliService = ['--script', script, '--id', 'win-sv-acceptance-cli', '--dest', dest];

before(async () => {
  assert.equal(await win.cmd.isElevated(), true, 'these tests need administrator rights, use npm run test:acceptance');
});

after(async () => {
  await svc.uninstall(true).catch(() => {});
  await runCli(['uninstall', ...cliService, '--remove-files']);
  await win.cmd.run(win.cmd.sys('reg.exe'), ['delete', SOURCE_KEY, '/f']).catch(() => {});
  removeDir(dest);
});

test('install and start in one call', async () => {
  await svc.install({ start: true });
  assert.equal(await svc.status(), 'Active (running)');
  assert.equal(await svc.isInstalled(), true);
  assert.equal(await svc.isRunning(), true);
  assert.deepEqual(events, ['install', 'start']);
});

let first;
test('arguments, environment and working directory reach the script', async () => {
  first = await server(PORT);
  assert.deepEqual(first.args, ['hello world', '--flag=1']);
  assert.equal(first.greeting, 'hi & <bye>');
  assert.equal(first.cwd.toLowerCase(), path.dirname(script).toLowerCase());
});

test('the service account is set by the program, without a prompt', async () => {
  // Installed but never started: these accounts cannot read a script kept in a user profile.
  // A user account with a password takes the same path, with the password on the install command line.
  const local = new win.Service({ id: 'win-sv-acceptance-account', script, winswDest: dest, winswDir: 'account', startmode: 'manual', logOnAs: 'LocalService' });
  try {
    await local.install();
    assert.equal((await win.services.get(local.id)).account.toLowerCase(), 'nt authority\\localservice');
    await local.uninstall(true);

    // an account given to install() replaces the configured one
    await local.install({ user: 'NetworkService' });
    assert.equal((await win.services.get(local.id)).account.toLowerCase(), 'nt authority\\networkservice');
  } finally {
    await local.uninstall(true);
  }

  const args = ['--script', script, '--id', 'win-sv-acceptance-account', '--dest', dest, '--startmode', 'manual'];
  try {
    const install = await runCli(['install', ...args, '--user', 'NetworkService']);
    assert.equal(install.code, 0, install.stderr);
    assert.equal((await win.services.get('win-sv-acceptance-account')).account.toLowerCase(), 'nt authority\\networkservice');
  } finally {
    await runCli(['uninstall', ...args, '--remove-files']);
  }
});

test('the service is registered as configured', async () => {
  const info = await win.services.get(svc.id);
  assert.equal(info.name, svc.id);
  assert.equal(info.displayName, 'win-sv acceptance test');
  assert.equal(info.description, 'Temporary service created by the win-sv tests');
  assert.equal(info.state, 'running');
  assert.equal(info.startMode, 'manual');
  assert.equal(info.account.toLowerCase(), 'localsystem');
  assert.ok(info.path.includes(svc.exePath));
  assert.ok(info.pid > 0);

  const found = await win.services.list('win-sv-acceptance');
  assert.deepEqual(found.map(service => service.name), [svc.id]);
});

test('the wrapper and the script are in the process list', async () => {
  const info = await win.services.get(svc.id);
  const tasks = await win.process.list();
  const wrapper = tasks.find(task => task.pid === info.pid);
  assert.equal(wrapper.name.toLowerCase(), svc.id + '.exe');
  const child = tasks.find(task => task.pid === first.pid);
  assert.equal(child.ppid, wrapper.pid, 'the script is a child of the wrapper');
  assert.ok(child.commandLine.includes('hello world'));
});

test('logs returns the output of the script', async () => {
  await waitFor('the output log', async () => (await svc.logs()).includes('listening on ' + PORT), 10000);
  assert.ok((await svc.logs()).includes('starting with ["hello world","--flag=1"]'));
  assert.ok((await svc.logs('err')).includes('this line goes to the error output'));
  assert.notEqual(await svc.logs('wrapper'), '');
  assert.equal((await svc.logs({ lines: 1 })).split('\n').length, 1);
});

let second;
test('Windows restarts the service after a crash', async () => {
  await win.process.kill(first.pid, true);
  second = await server(PORT, first.pid);
  assert.equal(await svc.status(), 'Active (running)');
});

test('restart', async () => {
  await svc.restart();
  await server(PORT, second.pid);
});

test('refresh applies configuration changes', async () => {
  await svc.refresh({ description: 'refreshed description' });
  assert.equal((await win.services.get(svc.id)).description, 'refreshed description');
});

test('stop lets the script shut down by itself', async () => {
  fs.rmSync(stopFile, { force: true });
  await svc.stop();
  assert.equal(await svc.status(), 'Inactive (stopped)');
  assert.equal(await svc.isRunning(), false);
  assert.equal(fs.readFileSync(stopFile, 'utf8'), 'stopped by SIGINT');
  await assert.rejects(ask(PORT));
});

test('services.start, restart and stop by name', async () => {
  await win.services.start(svc.id);
  const running = await server(PORT);
  assert.equal(await win.services.start(svc.id), '', 'starting a running service does nothing');

  await win.services.restart(svc.id);
  await server(PORT, running.pid);

  await win.services.stop(svc.id);
  assert.equal((await win.services.get(svc.id)).state, 'stopped');
  assert.equal(await win.services.stop(svc.id), '', 'stopping a stopped service does nothing');

  // restart also starts a stopped service
  await win.process.restart(svc.id);
  assert.equal(await svc.status(), 'Active (running)');
  await svc.stop();
});

test('installing over an installed service fails and leaves it untouched', async () => {
  await assert.rejects(svc.install(), error => error.code === 1073);
  assert.equal(await svc.status(), 'Inactive (stopped)');
});

test('uninstall stops a running service and removes its files', async () => {
  await svc.start();
  await svc.uninstall(true);
  assert.equal(await svc.status(), 'NonExistent');
  assert.equal(fs.existsSync(svc.winswPath), false);
  assert.equal(await win.services.get(svc.id), undefined);
  assert.deepEqual([...new Set(events)].sort(), ['install', 'refresh', 'restart', 'start', 'stop', 'uninstall']);
});

test('command line: install --start, status, logs, list, restart, stop, uninstall', async () => {
  const install = await runCli(['install', ...cliService, '--env', 'PORT=' + PORT, '--startmode', 'manual', '--restart-delay', '1',
    '--start', '--', 'from the cli']);
  assert.equal(install.code, 0, install.stderr);
  assert.equal((await runCli(['status', ...cliService])).stdout, 'Active (running)');
  const info = await server(PORT);
  assert.deepEqual(info.args, ['from the cli']);

  await waitFor('the output log', async () => (await runCli(['logs', ...cliService])).stdout.includes('listening on ' + PORT), 10000);
  assert.ok((await runCli(['logs', ...cliService, '--err'])).stdout.includes('error output'));

  const list = await runCli(['list', 'win-sv-acceptance-cli', '--json']);
  const [listed] = JSON.parse(list.stdout);
  assert.equal(listed.state, 'running');
  assert.match((await runCli(['list', 'win-sv-acceptance-cli'])).stdout, /^NAME\s+STATE\s+STARTMODE\s+DISPLAYNAME\r?\nwin-sv-acceptance-cli\s+running\s+manual\s+/);

  assert.equal((await runCli(['restart', ...cliService])).code, 0);
  await server(PORT, info.pid);
  assert.equal((await runCli(['stop', ...cliService])).code, 0);
  assert.equal((await runCli(['status', ...cliService])).stdout, 'Inactive (stopped)');
  assert.equal((await runCli(['start', ...cliService])).code, 0);

  const uninstall = await runCli(['uninstall', ...cliService, '--remove-files']);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal((await runCli(['status', ...cliService])).stdout, 'NonExistent');
  assert.equal(fs.existsSync(path.join(dest, 'daemon')), false);
});

test('event log: register a source, write every level, read them back', async () => {
  const logger = new win.EventLogger(SOURCE);
  let registered = 0;
  logger.on('register', () => registered++);
  await logger.registerEventSource();
  assert.equal(registered, 1);
  assert.equal(await logger.isRegistered(), true);

  await logger.info('multi line\nmessage with "quotes" & <symbols>', 7);
  await logger.warn('warning from the win-sv tests', 20);
  await logger.error('error from the win-sv tests', 30);
  await logger.success('success from the win-sv tests');

  const query = `*[System[Provider[@Name="${SOURCE}"]]]`;
  const out = await win.cmd.run(win.cmd.sys('wevtutil.exe'), ['qe', 'Application', '/c:4', '/rd:true', '/f:xml', '/q:' + query]);
  // event id and level (4 information, 3 warning, 2 error, 0 success), then the message
  const written = [...out.matchAll(/<EventID[^>]*>(\d+)<\/EventID>[\s\S]*?<Level>(\d)<\/Level>[\s\S]*?<Data>([\s\S]*?)<\/Data>/g)]
    .map(match => `${match[1]} ${match[2]} ${match[3].replace(/\r\n/g, '\n')}`).reverse();
  assert.deepEqual(written, [
    '7 4 multi line\nmessage with "quotes" &amp; &lt;symbols&gt;',
    '20 3 warning from the win-sv tests',
    '30 2 error from the win-sv tests',
    '1000 0 success from the win-sv tests',
  ]);
});

test('event log: the system log', async () => {
  // a source belongs to one log, so this one needs its own name
  const logger = new win.EventLogger(SOURCE + ' (system)', true);
  await logger.info('system event from the win-sv tests', 9);
  const query = `*[System[Provider[@Name="${SOURCE} (system)"]]]`;
  const out = await win.cmd.run(win.cmd.sys('wevtutil.exe'), ['qe', 'System', '/c:1', '/rd:true', '/f:xml', '/q:' + query]);
  assert.ok(out.includes('system event from the win-sv tests'));
  await win.cmd.run(win.cmd.sys('reg.exe'), ['delete', SOURCE_KEY.replace('\\Application\\', '\\System\\') + ' (system)', '/f']);
});
