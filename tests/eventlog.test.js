'use strict';

// EventLogger. `eventcreate` is replaced by a stub, integration.js writes real events.

const test = require('node:test');
const assert = require('node:assert/strict');

const { EventLogger, cmd } = require('../index');

/** Records what would be sent to eventcreate, as an object keyed by switch. */
function capture(t) {
  const calls = [];
  t.mock.method(cmd, 'execute', async (file, args) => {
    assert.equal(file, 'eventcreate');
    const call = {};
    for (let i = 0; i < args.length; i += 2) { call[args[i]] = args[i + 1] }
    calls.push(call);
    return 'SUCCESS: An event was created.';
  });
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

test('the system log', async t => {
  const calls = capture(t);
  await new EventLogger('My App', true).info('started');
  assert.equal(calls[0]['/L'], 'SYSTEM');
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

test('a failed write rejects', async t => {
  t.mock.method(cmd, 'execute', async () => { throw new Error('ERROR: Access is denied.') });
  await assert.rejects(new EventLogger('src').info('message'), /Access is denied/);
});

test('isRegistered looks the source up in the registry', async t => {
  assert.equal(await new EventLogger('win-sv no such source ' + process.pid).isRegistered(), false);
  // registered by Windows itself
  assert.equal(await new EventLogger('Application Error').isRegistered(), true);
  assert.equal(await new EventLogger('Service Control Manager', true).isRegistered(), true);

  const queries = [];
  t.mock.method(cmd, 'run', async (file, args) => { queries.push([file, ...args].join(' ')) });
  await new EventLogger('My App').isRegistered();
  await new EventLogger('My App', true).isRegistered();
  assert.deepEqual(queries, [
    'reg query HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\My App',
    'reg query HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\System\\My App',
  ]);
});

test('registerEventSource does nothing for a registered source', async t => {
  t.mock.method(cmd, 'elevate', async () => assert.fail('no elevation expected'));
  const log = new EventLogger('Application Error');
  let registered = 0;
  log.on('register', () => registered++);
  assert.equal(await log.registerEventSource(), true);
  assert.equal(registered, 1);
});

test('registerEventSource creates a missing source as administrator', async t => {
  const calls = [];
  t.mock.method(cmd, 'isElevated', async () => false);
  t.mock.method(cmd, 'elevate', async (file, args) => { calls.push([file, ...args]) });
  t.mock.method(cmd, 'run', async (file, args) => {
    if (file === 'reg') { throw new Error('ERROR: The system was unable to find the specified registry key or value.') }
    calls.push(['not elevated', file, ...args]);
  });

  const log = new EventLogger('My App');
  assert.equal(await log.registerEventSource(), true);
  assert.deepEqual(calls, [
    ['eventcreate', '/L', 'APPLICATION', '/T', 'INFORMATION', '/ID', '1', '/SO', 'My App', '/D', 'Event source "My App" registered.'],
  ]);

  // an elevated process registers directly, without a prompt
  cmd.isElevated.mock.mockImplementation(async () => true);
  await log.registerEventSource();
  assert.deepEqual(calls[1].slice(0, 2), ['not elevated', 'eventcreate']);
});

test('a declined elevation rejects and does not emit', async t => {
  t.mock.method(cmd, 'isElevated', async () => false);
  t.mock.method(cmd, 'elevate', async () => { throw Object.assign(new Error('The operation was canceled by the user.'), { code: 1223 }) });
  const log = new EventLogger('win-sv no such source ' + process.pid);
  log.on('register', () => assert.fail('register must not be emitted'));
  await assert.rejects(log.registerEventSource(), error => error.code === 1223);
});
