'use strict';

// Reading the log files written next to the wrapper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Service } = require('../index');
const { script, tmpDir, waitFor } = require('./helpers');

function service(t, config) {
  const svc = new Service({ id: 'svc', script, winswDest: tmpDir(t), ...config });
  fs.mkdirSync(svc.logPath, { recursive: true });
  const write = (name, text, age) => {
    const file = path.join(svc.logPath, name);
    fs.writeFileSync(file, text);
    if (age) { fs.utimesSync(file, new Date(Date.now() - age * 1000), new Date(Date.now() - age * 1000)) }
    return file;
  };
  return { svc, write };
}

test('logs are next to the wrapper unless logpath is set', t => {
  const { svc } = service(t);
  assert.equal(svc.logPath, svc.winswPath);
  const dir = tmpDir(t);
  assert.equal(new Service({ id: 'svc', script, logpath: dir }).logPath, dir);
});

test('no log yet', async t => {
  const { svc } = service(t);
  assert.equal(svc.logFile(), undefined);
  assert.equal(await svc.logs(), '');
  assert.equal(await svc.logs('err'), '');
  const never = new Service({ id: 'svc', script, winswDest: path.join(tmpDir(t), 'missing') });
  assert.equal(never.logFile('wrapper'), undefined);
  assert.equal(await never.logs(), '');
});

test('each kind of log', async t => {
  const { svc, write } = service(t);
  const out = write('svc.out.log', 'listening\r\n');
  const err = write('svc.err.log', 'boom\r\n');
  const wrapper = write('svc.wrapper.log', 'Starting\r\n');
  write('other.out.log', 'not mine\r\n');
  write('svc2.out.log', 'not mine either\r\n');

  assert.equal(svc.logFile(), out);
  assert.equal(svc.logFile('out'), out);
  assert.equal(svc.logFile('err'), err);
  assert.equal(svc.logFile('wrapper'), wrapper);
  assert.equal(await svc.logs(), 'listening');
  assert.equal(await svc.logs('err'), 'boom');
  assert.equal(await svc.logs({ type: 'wrapper' }), 'Starting');
  assert.throws(() => svc.logFile('debug'), /Invalid log type/);
  await assert.rejects(svc.logs({ type: 'debug' }), /Invalid log type/);
});

test('only the last lines are returned', async t => {
  const { svc, write } = service(t);
  write('svc.out.log', Array.from({ length: 250 }, (v, i) => 'line ' + (i + 1)).join('\r\n') + '\r\n');
  const all = (await svc.logs()).split('\n');
  assert.equal(all.length, 100);
  assert.equal(all[0], 'line 151');
  assert.equal(all[99], 'line 250');
  assert.equal(await svc.logs({ lines: 2 }), 'line 249\nline 250');
  assert.equal((await svc.logs({ lines: 1000 })).split('\n').length, 250);
  assert.equal((await svc.logs({ lines: 0 })).split('\n').length, 100);
});

test('text is read as UTF-8, with either kind of line ending', async t => {
  const { svc, write } = service(t);
  write('svc.out.log', 'café ✓\nsecond\n');
  assert.equal(await svc.logs(), 'café ✓\nsecond');
  write('svc.out.log', '');
  assert.equal(await svc.logs(), '');
});

test('with rolling logs the most recent file is read', async t => {
  const { svc, write } = service(t, { log: { mode: 'roll-by-time' } });
  write('svc.20240101.out.log', 'old\r\n', 3600);
  const latest = write('svc.20240102.out.log', 'new\r\n', 60);
  write('svc.20240102.err.log', 'errors\r\n');
  assert.equal(svc.logFile(), latest);
  assert.equal(await svc.logs(), 'new');

  // roll-by-size keeps writing to the plain name and numbers the older ones
  write('svc.0.out.log', 'rolled\r\n', 30);
  const current = write('svc.out.log', 'current\r\n');
  assert.equal(svc.logFile(), current);
});

test('the id is matched without regard to case', async t => {
  const { svc, write } = service(t, { id: 'My.Svc' });
  write('my.svc.out.log', 'found\r\n');
  assert.equal(await svc.logs(), 'found');
});

test('watchLogs reports what is appended', async t => {
  const { svc, write } = service(t);
  const file = write('svc.out.log', 'before\r\n');
  const seen = [];
  const watcher = svc.watchLogs({ interval: 20 }, text => seen.push(text));
  t.after(() => watcher.close());

  fs.appendFileSync(file, 'one\r\n');
  await waitFor('the first line', () => seen.join('').includes('one'), 5000);
  fs.appendFileSync(file, 'two\r\n');
  await waitFor('the second line', () => seen.join('').includes('two'), 5000);
  assert.equal(seen.join(''), 'one\r\ntwo\r\n', 'what was there before is not repeated');

  // a truncated file is read again from its start
  fs.writeFileSync(file, 'x\r\n');
  await waitFor('the truncated file', () => seen.join('').endsWith('x\r\n'), 5000);

  watcher.close();
  const count = seen.length;
  fs.appendFileSync(file, 'after close\r\n');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(seen.length, count);
});

test('watchLogs picks up a file created later and accepts the type alone', async t => {
  const { svc, write } = service(t);
  const seen = [];
  const watcher = svc.watchLogs('err', text => seen.push(text));
  t.after(() => watcher.close());
  write('svc.out.log', 'not this one\r\n');
  write('svc.err.log', 'first error\r\n');
  await waitFor('the new file', () => seen.join('') === 'first error\r\n', 5000);
});
