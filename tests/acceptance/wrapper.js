'use strict';

// The contract between this package and the wrapper executable it copies for each service.
//
// Nothing from lib/ is used to drive the wrapper here: the configuration file is written by hand and the
// executable is called directly, so this file states exactly what a replacement has to do. Run it against
// another executable with:
//
//   set WIN_SV_EXE=C:\path\to\wrapper.exe
//   npm run test:acceptance
//
// Needs administrator rights (tests/acceptance/run.js asks for them once). The tests run in order
// and build on each other.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { script, waitFor, wrapper, exec, ask, server, tmpDir, removeDir } = require('./helpers');

const ID = 'win-sv-contract';
const PORT = 39418;
const dir = tmpDir();
const exe = path.join(dir, ID + '.exe');
const xml = path.join(dir, ID + '.xml');
const stopFile = path.join(dir, 'stopped.txt');
const sc = path.join(process.env.SystemRoot, 'System32', 'sc.exe');
const taskkill = path.join(process.env.SystemRoot, 'System32', 'taskkill.exe');

// Every element the package can generate that changes how the service behaves. The wrapper finds this
// file by its own name: <id>.exe reads <id>.xml in the same folder.
const config = description => `<service>
	<id>${ID}</id>
	<name>win-sv contract test</name>
	<description>${description}</description>
	<executable>${process.execPath}</executable>
	<arguments>"${script}" "two words" --flag=1</arguments>
	<workingdirectory>${path.dirname(script)}</workingdirectory>
	<env name="PORT" value="${PORT}"/>
	<env name="WINSV_GREETING" value="hi &amp; &lt;bye&gt;"/>
	<env name="WINSV_STOP_FILE" value="${stopFile}"/>
	<startmode>manual</startmode>
	<stoptimeout>10 sec</stoptimeout>
	<resetfailure>60 sec</resetfailure>
	<onfailure action="restart" delay="1 sec"/>
</service>
`;

const wrap = (...args) => exec(exe, args, { cwd: dir });
const status = async () => (await wrap('status')).stdout;
const log = type => fs.readFileSync(path.join(dir, `${ID}.${type}.log`), 'utf8');

before(() => {
  fs.copyFileSync(wrapper, exe);
  fs.writeFileSync(xml, '\ufeff' + config('before refresh').replace(/\n/g, '\r\n'), 'utf8');
});

after(async () => {
  await wrap('stop');
  await wrap('uninstall');
  await exec(sc, ['delete', ID]);
  removeDir(dir);
});

test('status of a service that is not installed: "NonExistent", exit code 1060', async () => {
  assert.deepEqual(await wrap('status'), { code: 1060, stdout: 'NonExistent', stderr: '' });
});

test('start and stop of a service that is not installed fail with 1060', async () => {
  assert.equal((await wrap('start')).code, 1060);
  assert.equal((await wrap('stop')).code, 1060);
});

test('install registers the service described by the file', async () => {
  const res = await wrap('install');
  assert.equal(res.code, 0, res.stdout + res.stderr);

  const query = await exec(sc, ['qc', ID]);
  assert.equal(query.code, 0);
  assert.ok(query.stdout.includes(exe), 'the service runs the wrapper');
  assert.ok(query.stdout.includes('win-sv contract test'), 'display name');
  assert.match(query.stdout, /:\s*3\s+DEMAND_START/, 'manual start');
  assert.ok((await exec(sc, ['qdescription', ID])).stdout.includes('before refresh'));
});

test('status of a stopped service: "Inactive (stopped)", exit code 0', async () => {
  assert.deepEqual(await wrap('status'), { code: 0, stdout: 'Inactive (stopped)', stderr: '' });
});

test('install of an installed service fails with 1073', async () => {
  assert.equal((await wrap('install')).code, 1073);
  assert.equal(await status(), 'Inactive (stopped)');
});

let first;
test('start waits for the service; status is then "Active (running)", exit code 1', async () => {
  const res = await wrap('start');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.deepEqual(await wrap('status'), { code: 1, stdout: 'Active (running)', stderr: '' });
  first = await server(PORT);
});

test('arguments, environment and working directory reach the process', () => {
  assert.deepEqual(first.args, ['two words', '--flag=1']);
  assert.equal(first.greeting, 'hi & <bye>');
  assert.equal(first.cwd.toLowerCase(), path.dirname(script).toLowerCase());
});

test('the output of the process is written to <id>.out.log and <id>.err.log', async () => {
  await waitFor('the output log', () => log('out').includes('listening on ' + PORT), 10000);
  assert.ok(log('out').includes('starting with ["two words","--flag=1"]'));
  assert.ok(log('err').includes('this line goes to the error output'));
  assert.ok(fs.existsSync(path.join(dir, ID + '.wrapper.log')), 'the wrapper keeps its own log');
});

let second;
test('when the process dies, Windows restarts the service as <onfailure> says', async () => {
  assert.equal((await exec(taskkill, ['/PID', String(first.pid), '/F'])).code, 0);
  second = await server(PORT, first.pid);
  assert.equal(await status(), 'Active (running)');
});

let third;
test('restart stops and starts the service', async () => {
  const res = await wrap('restart');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  third = await server(PORT, second.pid);
  assert.equal(await status(), 'Active (running)');
});

test('stop lets the process finish by itself before reporting the service stopped', async () => {
  fs.rmSync(stopFile, { force: true });
  const res = await wrap('stop');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(await status(), 'Inactive (stopped)');
  assert.equal(fs.readFileSync(stopFile, 'utf8'), 'stopped by SIGINT', 'the process received Ctrl+C and was not just killed');
  assert.ok(log('out').includes('stopping'));
  await assert.rejects(ask(PORT), 'the process is gone');
  assert.ok(third.pid);
});

test('refresh applies a changed file without reinstalling', async () => {
  fs.writeFileSync(xml, '\ufeff' + config('after refresh').replace(/\n/g, '\r\n'), 'utf8');
  const res = await wrap('refresh');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.ok((await exec(sc, ['qdescription', ID])).stdout.includes('after refresh'));
});

test('a file that cannot be read fails every command', async () => {
  const good = fs.readFileSync(xml);
  fs.writeFileSync(xml, '<service><id>broken</service>');
  try {
    assert.notEqual((await wrap('status')).code, 0);
    assert.notEqual((await wrap('start')).code, 0);
  } finally {
    fs.writeFileSync(xml, good);
  }
  assert.equal(await status(), 'Inactive (stopped)');
});

test('uninstall removes the service', async () => {
  const res = await wrap('uninstall');
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.equal(await status(), 'NonExistent');
  assert.equal((await exec(sc, ['query', ID])).code, 1060);
});

test('uninstall of a service that is not installed succeeds', async () => {
  assert.equal((await wrap('uninstall')).code, 0);
});
