'use strict';

// Running commands, and deciding when to ask for administrator rights.
// No UAC prompt is ever shown here: the elevated side is replaced by a stub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Service, cmd } = require('../index');
const winsw = require('../lib/winsw');
const { script, tmpDir } = require('./helpers');

const node = process.execPath;
const fail = (code, message) => Object.assign(new Error(message), { code, stdout: '', stderr: message });

test('cmd.run resolves the trimmed output', async () => {
  assert.equal(await cmd.run(node, ['-e', 'console.log("  hello  ")']), 'hello');
  assert.equal(await cmd.run(node, ['-e', '']), '');
});

test('cmd.run passes arguments without a shell', async () => {
  const print = 'console.log(JSON.stringify(process.argv.slice(1)))';
  const args = ['two words', 'say "hi"', 'a&b', '%PATH%', '>out.txt', 'trailing\\', ''];
  assert.deepEqual(JSON.parse(await cmd.run(node, ['-e', print, ...args])), args);
  assert.deepEqual(JSON.parse(await cmd.run(node, ['-e', print, 42])), ['42']);
});

test('cmd.run rejects with the exit code and both outputs', async () => {
  await assert.rejects(cmd.run(node, ['-e', 'console.log("partial"); console.error("boom"); process.exit(3)']), error => {
    assert.deepEqual([error.code, error.message, error.stdout, error.stderr], [3, 'boom', 'partial', 'boom']);
    return true;
  });
  // the message falls back to the standard output
  await assert.rejects(cmd.run(node, ['-e', 'console.log("only out"); process.exit(1)']), /only out/);
  await assert.rejects(cmd.run('win-sv-no-such-command'), error => error.code === 'ENOENT');
  await assert.rejects(cmd.run(), /not provided/);
});

test('cmd.run honours options', async () => {
  const dir = fs.realpathSync(os.tmpdir());
  const out = await cmd.run(node, ['-e', 'console.log(process.cwd() + "|" + process.env.WINSV_TEST)'], {
    cwd: dir, env: { ...process.env, WINSV_TEST: 'yes' },
  });
  assert.equal(out.toLowerCase(), (dir + '|yes').toLowerCase());
});

test('system tools are addressed by their full path', () => {
  assert.equal(cmd.sys('net.exe').toLowerCase(), path.join(process.env.SystemRoot, 'System32', 'net.exe').toLowerCase());
  for (const tool of ['net.exe', 'taskkill.exe', 'tasklist.exe', 'eventcreate.exe', 'reg.exe', 'whoami.exe', 'WindowsPowerShell\\v1.0\\powershell.exe']) {
    assert.ok(fs.existsSync(cmd.sys(tool)), tool);
  }
});

test('cmd.powershell runs a script and keeps unicode', async () => {
  assert.equal(await cmd.powershell('Write-Output "h\u00e9llo \u2713"'), 'h\u00e9llo \u2713');
  assert.equal(await cmd.powershell('$env:WINSV_TEST'), '');
  assert.equal(await cmd.powershell('$env:WINSV_TEST', { env: { ...process.env, WINSV_TEST: "it's \"quoted\"" } }), "it's \"quoted\"");
  assert.deepEqual(JSON.parse(await cmd.powershell('ConvertTo-Json -Compress -InputObject @(1, 2)')), [1, 2]);
});

test('cmd.powershell reports a readable error', async () => {
  await assert.rejects(cmd.powershell('throw "something broke"'), error => {
    assert.equal(error.code, 1);
    assert.match(error.message, /^something broke/);
    assert.ok(!error.message.includes('CLIXML'));
    return true;
  });
  await assert.rejects(cmd.powershell('exit 7'), error => error.code === 7);
});

test('PowerShell is found, and can be chosen', () => {
  assert.ok(fs.existsSync(cmd.powershellExe()));
  assert.match(path.basename(cmd.powershellExe()).toLowerCase(), /^(powershell|pwsh)\.exe$/);
});

test('cmd.isElevated answers once', async () => {
  const first = cmd.isElevated();
  assert.equal(typeof await first, 'boolean');
  assert.equal(cmd.isElevated(), first, 'the answer cannot change while the process runs');
});

test('cmd.execute does not ask for elevation on ordinary failures', async t => {
  t.mock.method(cmd, 'isElevated', async () => false);
  t.mock.method(cmd, 'elevate', async () => assert.fail('no elevation expected'));
  await assert.rejects(cmd.execute(node, ['-e', 'console.error("plain failure"); process.exit(2)']), error => {
    assert.deepEqual([error.code, error.message], [2, 'plain failure']);
    return true;
  });
  assert.equal(await cmd.execute(node, ['-e', 'console.log("fine")']), 'fine');
});

test('cmd.execute retries elevated on access denied, by exit code or by text', async t => {
  const elevated = [];
  t.mock.method(cmd, 'isElevated', async () => false);
  t.mock.method(cmd, 'elevate', async (file, args, options) => { elevated.push([args, options]); return 'as admin' });

  assert.equal(await cmd.execute(node, ['-e', 'process.exit(5)'], { cwd: os.tmpdir() }), 'as admin');
  assert.equal(await cmd.execute(node, ['-e', 'console.error("ERROR: Access is denied."); process.exit(1)']), 'as admin');
  // a translated message is not recognised, the caller has to say when a failure means "denied"
  await assert.rejects(cmd.execute(node, ['-e', 'console.error("Zugriff verweigert"); process.exit(1)']), /Zugriff/);
  assert.equal(await cmd.execute(node, ['-e', 'console.error("Zugriff verweigert"); process.exit(1)'], { elevateOnFailure: true }), 'as admin');

  assert.equal(elevated.length, 3);
  assert.deepEqual(elevated[0][1], { cwd: os.tmpdir() }, 'elevateOnFailure is not passed on');
  assert.deepEqual(elevated[2][1], {});
});

test('cmd.execute never elevates a process that is already elevated', async t => {
  t.mock.method(cmd, 'isElevated', async () => true);
  t.mock.method(cmd, 'elevate', async () => assert.fail('already elevated'));
  await assert.rejects(cmd.execute(node, ['-e', 'process.exit(5)']), error => error.code === 5);
  await assert.rejects(cmd.execute(node, ['-e', 'process.exit(1)'], { elevateOnFailure: true }), error => error.code === 1);
});

test('cmd.admin runs directly when elevated and behind a prompt otherwise', async t => {
  const calls = [];
  const isElevated = t.mock.method(cmd, 'isElevated', async () => true);
  t.mock.method(cmd, 'run', async (file, args) => { calls.push(['run', file, ...args]); return 'direct' });
  t.mock.method(cmd, 'elevate', async (file, args) => { calls.push(['elevate', file, ...args]); return 'prompted' });

  assert.equal(await cmd.admin('tool.exe', ['a']), 'direct');
  isElevated.mock.mockImplementation(async () => false);
  assert.equal(await cmd.admin('tool.exe', ['b']), 'prompted');
  assert.deepEqual(calls, [['run', 'tool.exe', 'a'], ['elevate', 'tool.exe', 'b']]);
});

/**
 * Replaces the PowerShell launcher of `elevateAll`: decodes the job it would have run as administrator
 * and answers each command with `answer(command)`, like the elevated script does.
 */
function fakeElevation(t, answer) {
  const jobs = [];
  t.mock.method(cmd, 'powershell', async (launcher, options) => {
    assert.match(launcher, /-Verb RunAs/);
    const inner = Buffer.from(options.env.WINSV_ELEVATED, 'base64').toString('utf16le');
    const job = JSON.parse(Buffer.from(inner.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString('utf8'));
    jobs.push(job);
    const results = [];
    for (const command of job.commands) {
      const result = { code: 0, stdout: '', stderr: '', ...answer(command) };
      results.push(result);
      if (result.code !== 0) { break }
    }
    fs.writeFileSync(job.out, '\ufeff' + JSON.stringify(results));
    return '';
  });
  return jobs;
}

test('cmd.elevateAll sends every command through one prompt', async t => {
  const jobs = fakeElevation(t, command => ({ stdout: `  ran ${command.file}\r\n` }));
  const out = await cmd.elevateAll([['first.exe', ['a b', 'say "hi"']], { file: 'second.exe' }, ['third.exe', []]], { cwd: 'C:\\work' });
  assert.deepEqual(out, ['ran first.exe', 'ran second.exe', 'ran third.exe']);
  assert.equal(jobs.length, 1, 'one prompt');
  assert.deepEqual(jobs[0].commands, [
    { file: 'first.exe', args: '"a b" "say \\"hi\\""' },
    { file: 'second.exe', args: '' },
    { file: 'third.exe', args: '' },
  ]);
  assert.equal(jobs[0].cwd, 'C:\\work');
  assert.equal(jobs[0].utf8, false);
  assert.equal(fs.existsSync(path.dirname(jobs[0].out)), false, 'the temporary folder is removed');
});

test('cmd.elevateAll stops at the first failure and reports it', async t => {
  const ran = [];
  fakeElevation(t, command => {
    ran.push(command.file);
    return command.file === 'second.exe' ? { code: 1060, stdout: 'on stdout', stderr: 'The service does not exist' } : {};
  });
  await assert.rejects(cmd.elevateAll([['first.exe'], ['second.exe'], ['third.exe']]), error => {
    assert.deepEqual([error.code, error.message, error.stdout], [1060, 'The service does not exist', 'on stdout']);
    return true;
  });
  assert.deepEqual(ran, ['first.exe', 'second.exe']);
});

test('cmd.elevateAll gives a failure without output a message', async t => {
  fakeElevation(t, () => ({ code: 3 }));
  await assert.rejects(cmd.elevateAll([['silent.exe']]), /exit code 3 \(elevated\)/);
});

test('cmd.elevate returns the output of its command', async t => {
  const jobs = fakeElevation(t, () => ({ stdout: 'done' }));
  assert.equal(await cmd.elevate('tool.exe', ['x']), 'done');
  assert.deepEqual(jobs[0].commands, [{ file: 'tool.exe', args: 'x' }]);
  await assert.rejects(cmd.elevate(), /not provided/);
});

test('a declined prompt rejects with code 1223', async t => {
  t.mock.method(cmd, 'powershell', async () => { throw fail(1223, 'The operation was canceled by the user.') });
  await assert.rejects(cmd.elevate('tool.exe'), error => error.code === 1223 && /canceled/.test(error.message));
});

test('cmd.elevateAll validates its input before prompting', async t => {
  t.mock.method(cmd, 'powershell', async () => assert.fail('no prompt expected'));
  assert.deepEqual(await cmd.elevateAll([]), []);
  await assert.rejects(cmd.elevateAll([[]]), /not provided/);
  await assert.rejects(cmd.elevateAll([['tool.exe', ['x'.repeat(20000)]]]), /too long/);
});

/** A service with its files on disk, in a process without administrator rights. */
function unprivileged(t, status) {
  const svc = new Service({ id: 'svc', script, winswDest: tmpDir(t) });
  winsw.createFiles(svc.winswPath, svc.config);
  const direct = [];
  const prompts = [];
  t.mock.method(cmd, 'isElevated', async () => false);
  t.mock.method(cmd, 'run', async (file, args) => {
    direct.push(args.join(' '));
    return args[0] === 'status' ? status : args[0] + ' output';
  });
  t.mock.method(cmd, 'elevateAll', async (commands, options) => {
    assert.equal(options.cwd, svc.winswPath);
    prompts.push(commands.map(([file, args]) => { assert.equal(file, svc.exePath); return args.join(' ') }));
    return commands.map(([, args]) => args[0] + ' as admin');
  });
  const events = [];
  for (const name of ['install', 'start', 'stop', 'uninstall']) { svc.on(name, output => events.push(`${name}: ${output}`)) }
  return { svc, direct, prompts, events };
}

test('install and start share one prompt', async t => {
  const { svc, direct, prompts, events } = unprivileged(t);
  assert.equal(await svc.install({ start: true }), 'install as admin\nstart as admin');
  assert.deepEqual(prompts, [['install', 'start']]);
  assert.deepEqual(direct, []);
  assert.deepEqual(events, ['install: install as admin', 'start: start as admin']);
});

test('a single command is left to the wrapper, which prompts by itself', async t => {
  const { svc, direct, prompts } = unprivileged(t);
  await svc.install();
  await svc.start();
  await svc.stop();
  assert.deepEqual(direct, ['install', 'start', 'stop']);
  assert.deepEqual(prompts, []);
});

test('noElevate never prompts', async t => {
  const { svc, direct, prompts } = unprivileged(t, 'Active (running)');
  await svc.install({ start: true, noElevate: true });
  await svc.uninstall({ noElevate: true });
  assert.deepEqual(direct, ['install --no-elevate', 'start --no-elevate', 'status', 'stop --no-elevate', 'uninstall --no-elevate']);
  assert.deepEqual(prompts, []);
});

test('uninstalling a running service stops and removes it behind one prompt', async t => {
  const { svc, direct, prompts, events } = unprivileged(t, 'Active (running)');
  assert.equal(await svc.uninstall({ removeFiles: true, force: true }), 'uninstall as admin');
  assert.deepEqual(direct, ['status']);
  assert.deepEqual(prompts, [['stop --force', 'uninstall']]);
  assert.deepEqual(events, ['stop: stop as admin', 'uninstall: uninstall as admin']);
  assert.equal(fs.existsSync(svc.winswPath), false);
});

test('a failed batch rejects and leaves the files', async t => {
  const { svc } = unprivileged(t, 'Active (running)');
  cmd.elevateAll.mock.mockImplementation(async () => { throw fail(1223, 'The operation was canceled by the user.') });
  svc.on('uninstall', () => assert.fail('uninstall must not be emitted'));
  await assert.rejects(svc.uninstall(true), error => error.code === 1223);
  assert.equal(svc.exists, true);
});
