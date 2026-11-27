'use strict';

// EventLogger. `eventcreate` is replaced by a stub, the acceptance tests write real events.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { EventLogger, cmd } = require('../index');

/**
 * Replaces the system tools. `registered` is what the registry lookup answers.
 * Returns the events that would be created, as objects keyed by switch, with `how` they were run.
 */
function capture(t, { registered = true, elevated = false } = {}) {
  const calls = [];
  const record = how => async (file, args) => {
    const tool = path.basename(file).toLowerCase();
    if (tool === 'reg.exe') {
      if (!registered) { throw Object.assign(new Error('ERROR: not found'), { code: 1 }) }
      return '';
    }
    assert.equal(tool, 'eventcreate.exe');
    const call = { how };
    for (let i = 0; i < args.length; i += 2) { call[args[i]] = args[i + 1] }
    calls.push(call);
    return 'SUCCESS: An event was created.';
  };
  t.mock.method(cmd, 'isElevated', async () => elevated);
  t.mock.method(cmd, 'run', record('direct'));
  t.mock.method(cmd, 'elevate', record('prompt'));
  return calls;
}

test('source and log', () => {
  assert.equal(new EventLogger().source, 'Node.js');
  assert.equal(new EventLogger().eventLog, 'APPLICATION');
  assert.equal(new EventLogger('  My App ').source, 'My App');
  assert.equal(new EventLogger('src', true).eventLog, 'SYSTEM');
  assert.equal(new EventLogger('src', false).eventLog, 'APPLICATION');
  assert.equal(new EventLogger({ source: 'src', isSystem: true }).eventLog, 'SYSTEM');
  assert.equal(new EventLogger({ source: 'src', eventLog: 'system' }).eventLog, 'SYSTEM');
  assert.equal(new EventLogger({ source: 'src', eventLog: 'Security' }).eventLog, 'APPLICATION');
});

test('the log can be changed later', () => {
  const log = new EventLogger('src');
  log.eventLog = 'system';
  assert.equal(log.eventLog, 'SYSTEM');
  log.eventLog = 'nonsense';
  assert.equal(log.eventLog, 'APPLICATION');
});

test('each level maps to an event type', async t => {
  const calls = capture(t);
  const log = new EventLogger('My App');
  assert.equal(await log.info('started'), 'SUCCESS: An event was created.');
  await log.warn('careful');
  await log.error('broken');
  await log.success('done');
  assert.deepEqual(calls.map(call => call['/T']), ['INFORMATION', 'WARNING', 'ERROR', 'SUCCESS']);
  assert.deepEqual(calls.map(call => call['/D']), ['started', 'careful', 'broken', 'done']);
  assert.ok(calls.every(call => call['/L'] === 'APPLICATION' && call['/SO'] === 'My App' && call['/ID'] === '1000'));
});

test('event ids outside 1-1000 fall back to 1000', async t => {
  const calls = capture(t);
  const log = new EventLogger('src');
  for (const code of [1, 7, '42', 1000, 12.9, 0, -5, 1001, 'node', null, undefined, NaN]) {
    await log.info('message', code);
  }
  assert.deepEqual(calls.map(call => call['/ID']), ['1', '7', '42', '1000', '12', '1000', '1000', '1000', '1000', '1000', '1000', '1000']);
});

test('messages are sent as written', async t => {
  const calls = capture(t);
  const log = new EventLogger('src');
  await log.info('multiline\nmessage with "quotes", %PATH% & <symbols>');
  await log.error(new Error('from an error'));
  await log.warn(404);
  assert.deepEqual(calls.map(call => call['/D']), ['multiline\nmessage with "quotes", %PATH% & <symbols>', 'Error: from an error', '404']);
});

test('empty messages are not written', async t => {
  const calls = capture(t);
  const log = new EventLogger('src');
  for (const message of ['', '   ', '\r\n', null, undefined]) {
    assert.equal(await log.info(message), '');
  }
  assert.deepEqual(calls, []);
});

test('a registered source of the application log is written to without elevation', async t => {
  const calls = capture(t, { registered: true });
  await new EventLogger('My App').info('hello');
  assert.deepEqual(calls.map(call => call.how), ['direct']);
});

test('an unregistered source needs administrator rights once', async t => {
  const calls = capture(t, { registered: false });
  const log = new EventLogger('My App');
  await log.info('first');
  // eventcreate registered the source while writing as administrator
  await log.info('second');
  assert.deepEqual(calls.map(call => [call.how, call['/D']]), [['prompt', 'first'], ['direct', 'second']]);
});

test('the system log always needs administrator rights', async t => {
  const calls = capture(t, { registered: true });
  const log = new EventLogger('My App', true);
  await log.info('first');
  await log.warn('second');
  assert.deepEqual(calls.map(call => [call.how, call['/L']]), [['prompt', 'SYSTEM'], ['prompt', 'SYSTEM']]);
});

test('an elevated process never prompts', async t => {
  const calls = capture(t, { registered: false, elevated: true });
  await new EventLogger('My App').info('application');
  await new EventLogger('My App', true).info('system');
  assert.deepEqual(calls.map(call => call.how), ['direct', 'direct']);
});

test('a failed write rejects', async t => {
  capture(t);
  cmd.run.mock.mockImplementation(async file => {
    if (/reg\.exe$/i.test(file)) { return '' }
    throw Object.assign(new Error('ERROR: something went wrong'), { code: 1 });
  });
  await assert.rejects(new EventLogger('src').info('message'), /something went wrong/);
});

test('isRegistered looks the source up in the registry', async t => {
  assert.equal(await new EventLogger('win-sv no such source ' + process.pid).isRegistered(), false);
  // registered by Windows itself
  assert.equal(await new EventLogger('Application Error').isRegistered(), true);
  assert.equal(await new EventLogger('Service Control Manager', true).isRegistered(), true);

  const queries = [];
  t.mock.method(cmd, 'run', async (file, args) => { queries.push([path.basename(file), ...args].join(' ')) });
  await new EventLogger('My App').isRegistered();
  await new EventLogger('My App', true).isRegistered();
  assert.deepEqual(queries, [
    'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\My App',
    'reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\System\\My App',
  ]);
});

test('the answer is remembered once the source is known, and forgotten when the log changes', async t => {
  let lookups = 0;
  t.mock.method(cmd, 'run', async () => { lookups++; return '' });
  const log = new EventLogger('My App');
  await log.isRegistered();
  await log.isRegistered();
  assert.equal(lookups, 1);
  log.eventLog = 'SYSTEM';
  await log.isRegistered();
  assert.equal(lookups, 2);
});

test('registerEventSource does nothing for a registered source', async t => {
  const calls = capture(t, { registered: true });
  const log = new EventLogger('Application Error');
  let registered = 0;
  log.on('register', () => registered++);
  assert.equal(await log.registerEventSource(), true);
  assert.equal(registered, 1);
  assert.deepEqual(calls, []);
});

test('registerEventSource creates a missing source as administrator', async t => {
  const calls = capture(t, { registered: false });
  const log = new EventLogger('My App');
  assert.equal(await log.registerEventSource(), true);
  assert.deepEqual(calls, [{
    how: 'prompt', '/L': 'APPLICATION', '/T': 'INFORMATION', '/ID': '1', '/SO': 'My App', '/D': 'Event source "My App" registered.',
  }]);
  // from then on writing needs no rights
  await log.info('hello');
  assert.equal(calls[1].how, 'direct');
});

test('a declined elevation rejects and does not emit', async t => {
  capture(t, { registered: false });
  cmd.elevate.mock.mockImplementation(async () => { throw Object.assign(new Error('The operation was canceled by the user.'), { code: 1223 }) });
  const log = new EventLogger('My App');
  log.on('register', () => assert.fail('register must not be emitted'));
  await assert.rejects(log.registerEventSource(), error => error.code === 1223);
  await assert.rejects(log.info('still unregistered'), error => error.code === 1223);
});
