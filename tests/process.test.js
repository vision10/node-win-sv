'use strict';

// Process helpers and the command runner.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');

const win = require('../index');
const { parseTasklist } = require('../lib/process');
const { waitFor } = require('./helpers');

/** Starts a node process that does nothing until it is killed. */
function idleProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(() => child.kill());
  return { pid: child.pid, exited };
}

test('cmd.run resolves the trimmed output', async () => {
  assert.equal(await win.cmd.run(process.execPath, ['-e', 'console.log("  hello  ")']), 'hello');
  assert.equal(await win.cmd.run(process.execPath, ['-e', '']), '');
});

test('cmd.run passes arguments without a shell', async () => {
  const print = 'console.log(JSON.stringify(process.argv.slice(1)))';
  const args = ['two words', 'say "hi"', 'a&b', '%PATH%', '>out.txt', 'trailing\\', ''];
  assert.deepEqual(JSON.parse(await win.cmd.run(process.execPath, ['-e', print, ...args])), args);
  assert.deepEqual(JSON.parse(await win.cmd.run(process.execPath, ['-e', print, 42])), ['42']);
});

test('cmd.run rejects with the exit code and both outputs', async () => {
  const failing = 'console.log("partial"); console.error("boom"); process.exit(3)';
  await assert.rejects(win.cmd.run(process.execPath, ['-e', failing]), error => {
    assert.equal(error.code, 3);
    assert.equal(error.message, 'boom');
    assert.equal(error.stdout, 'partial');
    assert.equal(error.stderr, 'boom');
    return true;
  });
  // the message falls back to the standard output
  await assert.rejects(win.cmd.run(process.execPath, ['-e', 'console.log("only out"); process.exit(1)']), /only out/);
  await assert.rejects(win.cmd.run('win-sv-no-such-command'), error => error.code === 'ENOENT');
  await assert.rejects(win.cmd.run(), /not provided/);
  await assert.rejects(win.cmd.elevate(), /not provided/);
});

test('cmd.run honours options', async () => {
  const dir = require('os').tmpdir();
  const out = await win.cmd.run(process.execPath, ['-e', 'console.log(process.cwd() + "|" + process.env.WINSV_TEST)'], {
    cwd: dir, env: { ...process.env, WINSV_TEST: 'yes' },
  });
  assert.equal(out.toLowerCase(), (require('fs').realpathSync(dir) + '|yes').toLowerCase());
});

test('cmd.execute does not ask for elevation on ordinary failures', async () => {
  // a UAC prompt here would hang the test
  await assert.rejects(win.cmd.execute(process.execPath, ['-e', 'console.error("plain failure"); process.exit(2)']), error => {
    assert.equal(error.code, 2);
    assert.equal(error.message, 'plain failure');
    return true;
  });
  assert.equal(await win.cmd.execute(process.execPath, ['-e', 'console.log("fine")']), 'fine');
});

test('cmd.isElevated', async () => {
  assert.equal(typeof await win.cmd.isElevated(), 'boolean');
});

test('tasklist parsing', () => {
  const rows = parseTasklist('"Image Name","PID","Session Name","Session#","Mem Usage"\r\n"node.exe","42","Console","1","1,736 K"\r\n"a ""b"".exe","7","Services","0","10 K"\r\n');
  assert.deepEqual(rows, [
    { ImageName: 'node.exe', PID: '42', SessionName: 'Console', 'Session#': '1', MemUsage: '1,736 K' },
    { ImageName: 'a "b".exe', PID: '7', SessionName: 'Services', 'Session#': '0', MemUsage: '10 K' },
  ]);
  assert.deepEqual(parseTasklist(''), []);
  assert.deepEqual(parseTasklist('INFO: No tasks are running which match the specified criteria.'), []);
  assert.deepEqual(parseTasklist('"Image Name","PID"\n"x.exe","1"\n'), [{ ImageName: 'x.exe', PID: '1' }]);
});

test('process.list returns every process', async () => {
  const tasks = await win.process.list();
  assert.ok(tasks.length > 10);
  const me = tasks.find(task => Number(task.PID) === process.pid);
  assert.ok(me, 'this process is listed');
  assert.deepEqual(Object.keys(me).length, 5);
  assert.match(Object.values(me)[0], /^node(\.exe)?$/i);
});

test('process.list filters by text, pattern or function', async () => {
  const all = await win.process.list();
  const name = task => Object.values(task)[0];

  const byText = await win.process.list('NODE');
  assert.ok(byText.some(task => Number(task.PID) === process.pid));
  assert.ok(byText.every(task => /node/i.test(name(task))));
  assert.ok(byText.length < all.length);

  const byPattern = await win.process.list(/^node\.exe$/i);
  assert.ok(byPattern.some(task => Number(task.PID) === process.pid));
  assert.ok(byPattern.every(task => /^node\.exe$/i.test(name(task))));

  const byFunction = await win.process.list(task => Number(task.PID) === process.pid);
  assert.equal(byFunction.length, 1);

  assert.deepEqual(await win.process.list('win-sv-no-such-process'), []);
});

test('process.list verbose adds columns', { timeout: 120000 }, async () => {
  const [me] = await win.process.list(task => Number(task.PID) === process.pid, true);
  assert.equal(Object.keys(me).length, 9);
});

test('process.kill by pid', async t => {
  const child = idleProcess(t);
  await win.process.kill(child.pid, true);
  await child.exited;
  assert.deepEqual(await win.process.list(task => Number(task.PID) === child.pid), []);
});

test('process.kill accepts the pid as text and a filter', async t => {
  const first = idleProcess(t);
  await win.process.kill(String(first.pid), true);
  await first.exited;

  const second = idleProcess(t);
  await win.process.kill(undefined, `PID eq ${second.pid}`, true);
  await second.exited;

  const third = idleProcess(t);
  await win.process.kill(third.pid, 'IMAGENAME eq win-sv-not-this-one.exe', true);
  await waitFor('taskkill to finish', () => true, 500);
  assert.equal((await win.process.list(task => Number(task.PID) === third.pid)).length, 1, 'the filter excluded it');
});

test('process.kill needs a target', async () => {
  await assert.rejects(win.process.kill(), /required/);
  await assert.rejects(win.process.kill(''), /required/);
  await assert.rejects(win.process.kill(4194300, true), /not found/i);
});

test('service commands are passed to net', async t => {
  const calls = [];
  t.mock.method(win.cmd, 'execute', async (file, args) => { calls.push([file, ...args].join(' ')); return 'ok' });
  assert.equal(await win.process.start('My Service'), 'ok');
  await win.process.stop('My Service');
  await win.process.restart('My Service');
  assert.deepEqual(calls, ['net start My Service', 'net stop My Service', 'net stop My Service', 'net start My Service']);
});

test('process.restart starts a service that was not running', async t => {
  const calls = [];
  t.mock.method(win.cmd, 'execute', async (file, args) => {
    calls.push(args[0]);
    if (args[0] === 'stop') { throw new Error('The service is not started.\r\n\r\nMore help is available by typing NET HELPMSG 3521.') }
    return 'started';
  });
  assert.equal(await win.process.restart('svc'), 'started');
  assert.deepEqual(calls, ['stop', 'start']);
});

test('process.restart gives up when the service cannot be stopped', async t => {
  t.mock.method(win.cmd, 'execute', async () => { throw new Error('The service name is invalid.\r\n\r\nNET HELPMSG 2185.') });
  await assert.rejects(win.process.restart('svc'), /invalid/);
});

test('an unknown service is reported', async () => {
  await assert.rejects(win.process.start('win-sv-no-such-service'), /invalid|2185/i);
});
