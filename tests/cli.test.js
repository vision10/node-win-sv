'use strict';

// The win-sv command, limited to what does not change the machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const pkg = require('../package.json');
const { script, tmpDir, tag } = require('./helpers');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function run(args, options) {
  return new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

test('package.json points to the command', () => {
  assert.equal(path.resolve(__dirname, '..', pkg.bin['win-sv']), cli);
  assert.ok(fs.readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node'));
});

test('--version', async () => {
  assert.deepEqual(await run(['--version']), { code: 0, stdout: pkg.version, stderr: '' });
  assert.equal((await run(['-v'])).stdout, pkg.version);
});

test('--help, also shown without a command', async () => {
  for (const args of [['--help'], ['-h'], [], ['install', '--help']]) {
    const res = await run(args);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /Usage:/);
    for (const command of ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'xml']) {
      assert.match(res.stdout, new RegExp(`^  ${command} `, 'm'));
    }
  }
});

test('unknown commands and options fail', async () => {
  const command = await run(['explode', '-s', script]);
  assert.equal(command.code, 1);
  assert.match(command.stderr, /Unknown command "explode"/);
  assert.equal(command.stdout, '');

  const option = await run(['status', '-s', script, '--nonsense']);
  assert.equal(option.code, 1);
  assert.match(option.stderr, /nonsense/);
});

test('a script or an id is required', async () => {
  const res = await run(['status']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /required/);
});

test('xml prints the configuration, the id defaults to the script name', async () => {
  const res = await run(['xml', '--script', script]);
  assert.equal(res.code, 0);
  assert.equal(tag(res.stdout, 'id'), 'server');
  assert.equal(tag(res.stdout, 'arguments'), script);
  assert.equal(tag(res.stdout, 'executable'), process.execPath);
});

test('a relative script is resolved from the current directory', async () => {
  const res = await run(['xml', '-s', 'server.js'], { cwd: path.dirname(script) });
  assert.equal(tag(res.stdout, 'arguments'), script);
});

test('options map to the configuration', async () => {
  const res = await run([
    'xml', '-s', script, '-i', 'my-app', '-n', 'My App', '--description', 'does things', '-d', 'C:\\data',
    '--exec', 'C:\\tools\\node.exe', '--arg', 'two words', '--env', 'PORT=3000', '--env', 'URL=http://x/?a=b',
    '--logpath', 'C:\\logs', '--log', 'roll-by-size', '--startmode', 'manual', '--restart-delay', '10',
    '--', '--port=9000', '-x',
  ]);
  assert.equal(res.code, 0, res.stderr);
  const xml = res.stdout;
  assert.equal(tag(xml, 'id'), 'my-app');
  assert.equal(tag(xml, 'name'), 'My App');
  assert.equal(tag(xml, 'description'), 'does things');
  assert.equal(tag(xml, 'workingdirectory'), 'C:\\data');
  assert.equal(tag(xml, 'executable'), 'C:\\tools\\node.exe');
  assert.equal(tag(xml, 'arguments'), `${script} "two words" --port=9000 -x`);
  assert.ok(xml.includes('<env name="PORT" value="3000"/>'));
  assert.ok(xml.includes('<env name="URL" value="http://x/?a=b"/>'));
  assert.equal(tag(xml, 'logpath'), 'C:\\logs');
  assert.ok(xml.includes('<log mode="roll-by-size">'));
  assert.equal(tag(xml, 'startmode'), 'manual');
  assert.ok(xml.includes('<onfailure action="restart" delay="10 sec"/>'));
});

test('invalid values are reported', async () => {
  const env = await run(['xml', '-s', script, '--env', 'NOVALUE']);
  assert.equal(env.code, 1);
  assert.match(env.stderr, /Invalid --env "NOVALUE"/);

  const mode = await run(['xml', '-s', script, '--startmode', 'sometimes']);
  assert.equal(mode.code, 1);
  assert.match(mode.stderr, /startmode/);

  const log = await run(['install', '-s', script, '--log', 'sideways', '--no-elevate', '--dest', path.join(__dirname, 'never-created')]);
  assert.equal(log.code, 1);
  assert.match(log.stderr, /log\.mode/);
  assert.equal(fs.existsSync(path.join(__dirname, 'never-created')), false);
});

test('--config loads a JSON file, paths are relative to it', async t => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'service.json'), JSON.stringify({
    id: 'from-json', script: 'app/server.js', cwd: 'data', logpath: 'logs',
    env: { PORT: 1 }, onfailure: [{ action: 'restart', delay: 3 }], log: { mode: 'roll-by-time', pattern: 'yyyyMM' },
  }));
  const res = await run(['xml', '--config', path.join(dir, 'service.json')]);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(tag(res.stdout, 'id'), 'from-json');
  assert.equal(tag(res.stdout, 'arguments'), path.join(dir, 'app', 'server.js'));
  assert.equal(tag(res.stdout, 'workingdirectory'), path.join(dir, 'data'));
  assert.equal(tag(res.stdout, 'logpath'), path.join(dir, 'logs'));
  assert.equal(tag(res.stdout, 'pattern'), 'yyyyMM');
  assert.ok(res.stdout.includes('<onfailure action="restart" delay="3 sec"/>'));
});

test('--config loads a JS file, command line options win', async t => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'service.js'), `module.exports = { id: 'from-js', script: ${JSON.stringify(script)}, env: [{ name: 'A', value: '1' }], log: { mode: 'roll-by-size', keepFiles: 2 } };`);
  const res = await run(['xml', '-c', 'service.js', '--id', 'overridden', '--env', 'B=2', '--log', 'roll-by-size'], { cwd: dir });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(tag(res.stdout, 'id'), 'overridden');
  assert.ok(res.stdout.includes('<env name="A" value="1"/>'));
  assert.ok(res.stdout.includes('<env name="B" value="2"/>'));
  assert.equal(tag(res.stdout, 'keepFiles'), '2');

  const missing = await run(['xml', '-c', path.join(dir, 'missing.json')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Cannot find module/);
});

test('status of a service that is not installed', async t => {
  const res = await run(['status', '-s', script, '--dest', tmpDir(t)]);
  assert.deepEqual(res, { code: 0, stdout: 'NonExistent', stderr: '' });
});

test('commands on a service that is not installed fail without touching anything', async t => {
  const dest = tmpDir(t);
  for (const command of ['start', 'stop', 'restart']) {
    const res = await run([command, '-s', script, '--dest', dest, '--no-elevate']);
    assert.equal(res.code, 1, command);
    assert.match(res.stderr, /is the service installed\?/);
  }
  const uninstall = await run(['uninstall', '-s', script, '--dest', dest, '--remove-files', '--no-elevate']);
  assert.deepEqual(uninstall, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(fs.readdirSync(dest), []);
});
