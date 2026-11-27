'use strict';

// Querying and controlling any Windows service by name.
// Nothing is started or stopped here, `net` is replaced by a stub.

const test = require('node:test');
const assert = require('node:assert/strict');

const win = require('../index');
const { services, cmd } = win;

const NET = cmd.sys('net.exe');

/** Makes `services.get` answer with a service in the given state and records what is sent to `net`. */
function fake(t, state, elevated) {
  const calls = [];
  const stub = (kind, answer) => async (file, args) => {
    assert.equal(file, NET);
    calls.push(`${kind}: net ${args.join(' ')}`);
    return answer;
  };
  t.mock.method(services, 'get', async name => (state ? { name: 'ActualName', state } : undefined));
  t.mock.method(cmd, 'isElevated', async () => Boolean(elevated));
  t.mock.method(cmd, 'run', stub('run', 'ok'));
  t.mock.method(cmd, 'elevate', stub('elevate', 'ok as admin'));
  t.mock.method(cmd, 'elevateAll', async commands => {
    calls.push('one prompt: ' + commands.map(([file, args]) => { assert.equal(file, NET); return 'net ' + args.join(' ') }).join(' + '));
    return commands.map(() => 'ok as admin');
  });
  return calls;
}

test('get describes a service', async () => {
  const log = await services.get('eventlog');
  assert.deepEqual(Object.keys(log), ['name', 'displayName', 'description', 'state', 'startMode', 'pid', 'account', 'path', 'exitCode']);
  assert.equal(log.name, 'EventLog', 'the name is returned as registered, whatever the case asked for');
  assert.equal(log.state, 'running');
  assert.equal(log.startMode, 'automatic');
  assert.ok(log.pid > 0);
  assert.match(log.path, /svchost\.exe/i);
  assert.ok(log.displayName.length > 0);
  assert.ok(log.account.length > 0);
});

test('get resolves undefined for an unknown service, whatever the name contains', async () => {
  assert.equal(await services.get('win-sv-no-such-service'), undefined);
  assert.equal(await services.get("it's \\ odd \"name\" %PATH% $x"), undefined);
  // only the name is looked up, not the display name
  assert.equal(await services.get('Windows Event Log'), undefined);
});

test('list returns every service, sorted by name', async () => {
  const all = await services.list();
  assert.ok(all.length > 50);
  const names = all.map(service => service.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.ok(names.includes('EventLog'));
  const states = new Set(all.map(service => service.state));
  assert.ok(states.has('running') && states.has('stopped'));
  for (const service of all) {
    assert.match(service.state, /^(running|stopped|start-pending|stop-pending|paused|pause-pending|continue-pending)$/);
    assert.match(service.startMode, /^(automatic|manual|disabled|boot|system|unknown)$/);
    assert.equal(typeof service.pid, 'number');
  }
});

test('list filters by text, pattern or function', async t => {
  const rows = [
    { name: 'EventLog', displayName: 'Windows Event Log', state: 'running' },
    { name: 'Spooler', displayName: 'Print Spooler', state: 'stopped' },
    { name: 'W32Time', displayName: 'Windows Time', state: 'stopped' },
  ];
  t.mock.method(cmd, 'powershell', async () => JSON.stringify(rows));
  const names = async filter => (await services.list(filter)).map(service => service.name);

  assert.deepEqual(await names(), ['EventLog', 'Spooler', 'W32Time']);
  assert.deepEqual(await names('spool'), ['Spooler']);
  assert.deepEqual(await names('WINDOWS'), ['EventLog', 'W32Time'], 'the display name is searched too');
  assert.deepEqual(await names(/^w/i), ['EventLog', 'W32Time']);
  assert.deepEqual(await names(/^W3/), ['W32Time']);
  assert.deepEqual(await names(service => service.state === 'stopped'), ['Spooler', 'W32Time']);
  assert.deepEqual(await names('nothing'), []);
});

test('values are normalised', async t => {
  t.mock.method(cmd, 'powershell', async (script, options) => {
    assert.equal(options.env.WINSV_SERVICE, 'x');
    return JSON.stringify([{ name: 'x', displayName: null, description: null, state: 'Start Pending', startMode: 'Auto', pid: 0, account: null, path: null, exitCode: 1077 }]);
  });
  assert.deepEqual(await services.get('x'), {
    name: 'x', displayName: 'x', description: '', state: 'start-pending', startMode: 'automatic', pid: 0, account: '', path: '', exitCode: 1077,
  });
});

test('an unknown service is reported without prompting, in any language', async t => {
  const calls = fake(t, undefined);
  for (const action of ['start', 'stop', 'restart']) {
    await assert.rejects(services[action]('nope'), error => {
      assert.equal(error.code, 1060);
      assert.match(error.message, /"nope" does not exist/);
      return true;
    });
    await assert.rejects(services[action](), /name is required/);
  }
  assert.deepEqual(calls, []);
});

test('nothing is done when the service is already in the wanted state', async t => {
  let calls = fake(t, 'running');
  assert.equal(await services.start('svc'), '');
  assert.deepEqual(calls, []);
  t.mock.restoreAll();

  calls = fake(t, 'stopped');
  assert.equal(await services.stop('svc'), '');
  assert.deepEqual(calls, []);
});

test('start and stop run directly when that works', async t => {
  const starts = fake(t, 'stopped', true);
  assert.equal(await services.start('svc'), 'ok');
  assert.deepEqual(starts, ['run: net start ActualName /y']);
  t.mock.restoreAll();

  // also without administrator rights, for the services that allow it
  const stops = fake(t, 'running', false);
  assert.equal(await services.stop('svc'), 'ok');
  assert.deepEqual(stops, ['run: net stop ActualName /y']);
});

test('a refused start or stop is retried as administrator, without reading the message', async t => {
  const calls = fake(t, 'stopped');
  cmd.run.mock.mockImplementation(async () => { throw Object.assign(new Error('Systemfehler 5 aufgetreten.'), { code: 2 }) });
  assert.equal(await services.start('svc'), 'ok as admin');
  assert.deepEqual(calls, ['elevate: net start ActualName /y']);
  t.mock.restoreAll();

  const stops = fake(t, 'running');
  cmd.run.mock.mockImplementation(async () => { throw Object.assign(new Error('Erreur système 5.'), { code: 2 }) });
  assert.equal(await services.stop('svc'), 'ok as admin');
  assert.deepEqual(stops, ['elevate: net stop ActualName /y']);
});

test('an administrator gets the real error', async t => {
  fake(t, 'stopped', true);
  cmd.run.mock.mockImplementation(async () => { throw Object.assign(new Error('The service did not respond in a timely fashion.'), { code: 2 }) });
  await assert.rejects(services.start('svc'), /did not respond/);
});

test('restart stops then starts', async t => {
  const calls = fake(t, 'running', true);
  assert.equal(await services.restart('svc'), 'ok\nok');
  assert.deepEqual(calls, ['run: net stop ActualName /y', 'run: net start ActualName /y']);
});

test('restart without administrator rights uses one prompt for both steps', async t => {
  const calls = fake(t, 'running');
  assert.equal(await services.restart('svc'), 'ok as admin\nok as admin');
  assert.deepEqual(calls, ['one prompt: net stop ActualName /y + net start ActualName /y']);
});

test('restart only starts a stopped service', async t => {
  const calls = fake(t, 'stopped', true);
  assert.equal(await services.restart('svc'), 'ok');
  assert.deepEqual(calls, ['run: net start ActualName /y']);
});

test('process.start, stop and restart are the same functions', async t => {
  const calls = fake(t, 'running', true);
  assert.equal(await win.process.start('svc'), '');
  assert.equal(await win.process.stop('svc'), 'ok');
  await win.process.restart('svc');
  assert.deepEqual(calls, ['run: net stop ActualName /y', 'run: net stop ActualName /y', 'run: net start ActualName /y']);
});
