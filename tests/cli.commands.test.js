'use strict';

// The win-sv commands added after the service ones: logs, list, and the service account options.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const { script, tmpDir, tag, waitFor } = require('./helpers');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, options) {
  return new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** A wrapper folder with log files, as an installed service would have. */
function withLogs(t) {
  const dest = tmpDir(t);
  const dir = path.join(dest, 'daemon');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'server.out.log'), Array.from({ length: 150 }, (v, i) => 'out ' + (i + 1)).join('\r\n') + '\r\n');
  fs.writeFileSync(path.join(dir, 'server.err.log'), 'an error\r\n');
  fs.writeFileSync(path.join(dir, 'server.wrapper.log'), 'wrapper started\r\n');
  return { args: ['-s', script, '--dest', dest], out: path.join(dir, 'server.out.log') };
}

test('help lists the new commands and options', async () => {
  const { stdout } = await run(['--help']);
  assert.match(stdout, /^  logs /m);
  assert.match(stdout, /^  list /m);
  for (const option of ['--user <account>', '--password <password>', '--err', '--wrapper', '--lines <count>', '-f, --follow', '--json']) {
    assert.ok(stdout.includes(option), option);
  }
  assert.ok(stdout.includes('DOMAIN\\user'));
});

test('logs prints the last 100 lines of the output', async t => {
  const { args } = withLogs(t);
  const res = await run(['logs', ...args]);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split(/\r?\n/);
  assert.equal(lines.length, 100);
  assert.equal(lines[0], 'out 51');
  assert.equal(lines[99], 'out 150');
});

test('logs --lines, --err and --wrapper', async t => {
  const { args } = withLogs(t);
  assert.equal((await run(['logs', ...args, '--lines', '2'])).stdout.replace(/\r/g, ''), 'out 149\nout 150');
  assert.equal((await run(['logs', ...args, '--err'])).stdout, 'an error');
  assert.equal((await run(['logs', ...args, '--wrapper'])).stdout, 'wrapper started');
});

test('logs of a service without logs prints nothing', async t => {
  assert.deepEqual(await run(['logs', '-s', script, '--dest', tmpDir(t)]), { code: 0, stdout: '', stderr: '' });
});

test('logs --follow keeps printing what is appended', async t => {
  const { args, out } = withLogs(t);
  const child = spawn(process.execPath, [cli, 'logs', ...args, '--lines', '1', '--follow'], { windowsHide: true });
  t.after(() => child.kill());
  let printed = '';
  child.stdout.on('data', chunk => { printed += chunk });

  await waitFor('the last line', () => printed.includes('out 150'), 10000);
  fs.appendFileSync(out, 'appended later\r\n');
  await waitFor('the appended line', () => printed.includes('appended later'), 10000);
  assert.ok(!printed.includes('out 149'));
  assert.equal(child.exitCode, null, 'still following');
});

test('list prints a table of services', async () => {
  const res = await run(['list', 'eventlog']);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split(/\r?\n/);
  assert.match(lines[0], /^NAME\s+STATE\s+STARTMODE\s+DISPLAYNAME$/);
  assert.ok(lines.some(line => /^EventLog\s+running\s+automatic\s+\S/.test(line)));
});

test('list --json, filtered and unfiltered', async () => {
  const filtered = JSON.parse((await run(['list', 'eventlog', '--json'])).stdout);
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every(service => /eventlog/i.test(service.name + service.displayName)));
  assert.equal(filtered.find(service => service.name === 'EventLog').state, 'running');

  const all = JSON.parse((await run(['list', '--json'])).stdout);
  assert.ok(all.length > filtered.length);
  assert.deepEqual(JSON.parse((await run(['list', 'win-sv-no-such-service', '--json'])).stdout), []);
});

test('list needs no script', async () => {
  const res = await run(['list', 'win-sv-no-such-service']);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^NAME\s+STATE\s+STARTMODE\s+DISPLAYNAME$/);
});

test('--user with a built-in account', async () => {
  const xml = (await run(['xml', '-s', script, '--user', 'LocalService'])).stdout;
  assert.equal(tag(xml, 'username'), 'NT AUTHORITY\\LocalService');
  assert.ok(!xml.includes('<prompt>'));
});

test('--user alone asks for the password when installing', async () => {
  const xml = (await run(['xml', '-s', script, '--user', 'corp\\bob'])).stdout;
  assert.equal(tag(xml, 'username'), 'corp\\bob');
  assert.equal(tag(xml, 'prompt'), 'dialog');
});

test('--password, or WIN_SV_PASSWORD, replaces the prompt and stays out of the file', async () => {
  const given = (await run(['xml', '-s', script, '--user', 'corp\\bob', '--password', 'S3cret'])).stdout;
  assert.equal(tag(given, 'username'), 'corp\\bob');
  assert.ok(!given.includes('<prompt>'));
  assert.ok(!given.includes('S3cret'));

  const env = { ...process.env, WIN_SV_PASSWORD: 'FromEnv' };
  const fromEnv = (await run(['xml', '-s', script, '--user', 'corp\\bob'], { env })).stdout;
  assert.ok(!fromEnv.includes('<prompt>'));
  assert.ok(!fromEnv.includes('FromEnv'));
  // the variable alone does not select an account
  assert.ok(!(await run(['xml', '-s', script], { env })).stdout.includes('serviceaccount'));
});

test('--password without --user is refused', async () => {
  const res = await run(['xml', '-s', script, '--password', 'S3cret']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--password requires --user/);
});

test('--user completes the account of a config file', async t => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({ id: 'svc', script, logOnAs: { account: 'old', allowservicelogon: true, prompt: 'console' } }));
  const xml = (await run(['xml', '-c', path.join(dir, 'service.json'), '--user', 'corp\\new'])).stdout;
  assert.equal(tag(xml, 'username'), 'corp\\new');
  assert.equal(tag(xml, 'prompt'), 'console');
  assert.equal(tag(xml, 'allowservicelogon'), 'true');
});
