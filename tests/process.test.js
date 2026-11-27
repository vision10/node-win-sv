'use strict';

// Listing and killing processes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const win = require('../index');
const { cmd } = win;
const { parseTasklist } = require('../lib/process');
const { sleep } = require('./helpers');

const mine = task => task.pid === process.pid;

/** Starts a node process that does nothing until it is killed. */
function idleProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => child.kill());
  return { pid: child.pid, exited };
}

test('tasklist is parsed by position, whatever the language of its titles', () => {
  const english = '"Image Name","PID","Session Name","Session#","Mem Usage"\r\n"node.exe","42","Console","1","1,736 K"\r\n"a ""b"".exe","7","Services","0","10 K"\r\n';
  assert.deepEqual(parseTasklist(english), [
    { name: 'node.exe', pid: 42, sessionId: 1, memory: 1736 * 1024, sessionName: 'Console' },
    { name: 'a "b".exe', pid: 7, sessionId: 0, memory: 10 * 1024, sessionName: 'Services' },
  ]);
  const german = '"Abbildname","PID","Sitzungsname","Sitz.-Nr.","Speichernutzung"\r\n"node.exe","42","Console","1","1.736 K"\r\n';
  assert.deepEqual(parseTasklist(german), [{ name: 'node.exe', pid: 42, sessionId: 1, memory: 1736 * 1024, sessionName: 'Console' }]);
  const french = '"Nom de l\'image","PID","Nom de la session","Numéro de session","Utilisation mémoire"\n"node.exe","42","Console","1","1 736 Ko"\n';
  assert.equal(parseTasklist(french)[0].memory, 1736 * 1024);
});

test('verbose tasklist output', () => {
  const verbose = '"Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"\r\n'
    + '"cmd.exe","57516","Console","1","4,100 K","Running","PC\\bob","0:00:01","Command Prompt, with a comma"\r\n';
  assert.deepEqual(parseTasklist(verbose), [{
    name: 'cmd.exe', pid: 57516, sessionId: 1, memory: 4100 * 1024, sessionName: 'Console',
    status: 'Running', user: 'PC\\bob', cpuTime: '0:00:01', windowTitle: 'Command Prompt, with a comma',
  }]);
});

test('tasklist output without processes', () => {
  assert.deepEqual(parseTasklist(''), []);
  assert.deepEqual(parseTasklist('INFO: No tasks are running which match the specified criteria.'), []);
  assert.deepEqual(parseTasklist('"Image Name","PID","Session Name","Session#","Mem Usage"\r\n'), []);
});

test('list describes every process', async () => {
  const tasks = await win.process.list();
  assert.ok(tasks.length > 10);
  const me = tasks.find(mine);
  assert.deepEqual(Object.keys(me), ['name', 'pid', 'ppid', 'sessionId', 'memory', 'path', 'commandLine', 'startTime']);
  assert.match(me.name, /^node(\.exe)?$/i);
  assert.equal(me.path.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(me.ppid, process.ppid);
  assert.ok(me.memory > 1024 * 1024, 'memory is in bytes');
  assert.ok(me.commandLine.includes('process.test.js'));
  assert.ok(Math.abs(Date.parse(me.startTime) - (Date.now() - process.uptime() * 1000)) < 60000, 'startTime is an ISO date');
  for (const task of tasks) {
    assert.equal(typeof task.pid, 'number');
    assert.equal(typeof task.memory, 'number');
  }
});

test('list filters by text, pattern or function', async () => {
  const all = await win.process.list();

  const byText = await win.process.list('NODE');
  assert.ok(byText.some(mine));
  assert.ok(byText.every(task => /node/i.test(task.name)));
  assert.ok(byText.length < all.length);

  const byPattern = await win.process.list(/^node\.exe$/i);
  assert.ok(byPattern.some(mine));
  assert.ok(byPattern.every(task => /^node\.exe$/i.test(task.name)));

  assert.equal((await win.process.list(mine)).length, 1);
  assert.deepEqual(await win.process.list('win-sv-no-such-process'), []);
});

test('list can read tasklist instead, with the same basic fields', async () => {
  const [me] = await win.process.list(mine, { source: 'tasklist' });
  assert.deepEqual(Object.keys(me), ['name', 'pid', 'sessionId', 'memory', 'sessionName']);
  assert.match(me.name, /^node(\.exe)?$/i);
  assert.ok(me.memory > 1024 * 1024);

  const [fromWmi] = await win.process.list(mine, { source: 'wmi' });
  assert.equal(fromWmi.name, me.name);
  assert.equal(fromWmi.sessionId, me.sessionId);
  await assert.rejects(win.process.list(undefined, { source: 'guess' }), /Invalid source/);
});

test('list falls back to tasklist when WMI is unavailable', async t => {
  t.mock.method(cmd, 'powershell', async () => { throw new Error('WMI is broken') });
  const tasks = await win.process.list('node');
  assert.ok(tasks.some(mine));
  assert.ok(!('ppid' in tasks[0]));

  const [verbose] = await win.process.list(mine, true);
  assert.equal(Object.keys(verbose).length, 9);
  // asking for WMI explicitly reports the problem instead
  await assert.rejects(win.process.list(undefined, { source: 'wmi' }), /WMI is broken/);
});

test('verbose adds the user, status and window title', { timeout: 120000 }, async () => {
  const [me] = await win.process.list(mine, true);
  assert.deepEqual(Object.keys(me), ['name', 'pid', 'ppid', 'sessionId', 'memory', 'path', 'commandLine', 'startTime', 'sessionName', 'status', 'user', 'cpuTime', 'windowTitle']);
  assert.ok(me.user.toLowerCase().endsWith('\\' + require('os').userInfo().username.toLowerCase()));
  const [same] = await win.process.list(mine, { verbose: true });
  assert.equal(same.user, me.user);
});

test('kill by pid', async t => {
  const child = idleProcess(t);
  await win.process.kill(child.pid, true);
  await child.exited;
  assert.deepEqual(await win.process.list(task => task.pid === child.pid), []);
});

test('kill accepts the pid as text and a filter', async t => {
  const first = idleProcess(t);
  await win.process.kill(String(first.pid), true);
  await first.exited;

  const second = idleProcess(t);
  await win.process.kill(undefined, `PID eq ${second.pid}`, true);
  await second.exited;

  const third = idleProcess(t);
  await win.process.kill(third.pid, 'IMAGENAME eq win-sv-not-this-one.exe', true);
  await sleep(300);
  assert.equal((await win.process.list(task => task.pid === third.pid, { source: 'tasklist' })).length, 1, 'the filter excluded it');
});

test('kill needs a target', async () => {
  await assert.rejects(win.process.kill(), /required/);
  await assert.rejects(win.process.kill(''), /required/);
});

test('a process that is gone is reported, without asking for elevation', async t => {
  t.mock.method(cmd, 'elevate', async () => assert.fail('no elevation expected'));
  await assert.rejects(win.process.kill(4194300, true), error => error.code === 128);
  await assert.rejects(win.process.kill('win-sv-no-such-image.exe', true), error => error.code === 128);
});

test('a polite kill that is ignored does not ask for elevation', async t => {
  t.mock.method(cmd, 'elevate', async () => assert.fail('no elevation expected'));
  const child = idleProcess(t);
  // a process without a window cannot be closed without /F
  await assert.rejects(win.process.kill(child.pid), error => error.code === 1);
  assert.equal((await win.process.list(task => task.pid === child.pid, { source: 'tasklist' })).length, 1);
});

test('a forced kill refused for lack of rights is retried as administrator', async t => {
  const child = idleProcess(t);
  const elevated = [];
  const run = cmd.run;
  t.mock.method(cmd, 'isElevated', async () => false);
  t.mock.method(cmd, 'elevate', async (file, args) => { elevated.push(args.join(' ')); return 'killed as admin' });
  // taskkill is refused whatever the language of its message, the process is still there
  t.mock.method(cmd, 'run', async (file, args, options) => {
    if (/taskkill/i.test(file)) { throw Object.assign(new Error('FEHLER: Zugriff verweigert'), { code: 1 }) }
    return run(file, args, options);
  });

  assert.equal(await win.process.kill(child.pid, true), 'killed as admin');
  assert.deepEqual(elevated, [`/PID ${child.pid} /F`]);

  // an administrator gets the error instead of a second attempt
  cmd.isElevated.mock.mockImplementation(async () => true);
  await assert.rejects(win.process.kill(child.pid, true), /Zugriff/);
  assert.equal(elevated.length, 1);
});
