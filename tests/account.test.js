'use strict';

// The account a service runs as: asked for at install time by default, or given by the program.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { Service, generateXml, cmd } = require('../index');
const winsw = require('../lib/winsw');
const { script, tmpDir, tag } = require('./helpers');

const account = logOnAs => (generateXml({ id: 'svc', script, logOnAs }).match(/<serviceaccount>[\s\S]*<\/serviceaccount>/) || [''])[0];

/** A service whose wrapper calls are recorded instead of executed. */
function recorded(t, logOnAs) {
  const svc = new Service({ id: 'svc', script, winswDest: tmpDir(t), logOnAs });
  const calls = [];
  t.mock.method(cmd, 'isElevated', async () => true);
  t.mock.method(cmd, 'run', async (file, args) => { calls.push(args); return '' });
  return { svc, calls };
}

test('LocalSystem is the default and writes nothing', () => {
  assert.equal(account(undefined), '');
  assert.equal(account(true), '');
  assert.equal(account(false), '');
  assert.equal(winsw.installCredentials({ logOnAs: true }), undefined);
});

test('built-in accounts have no password and never prompt', () => {
  assert.equal(tag(account('LocalService'), 'username'), 'NT AUTHORITY\\LocalService');
  assert.equal(tag(account('networkservice'), 'username'), 'NT AUTHORITY\\NetworkService');
  assert.equal(tag(account('nt authority\\localservice'), 'username'), 'NT AUTHORITY\\LocalService');
  assert.equal(tag(account('localsystem'), 'username'), 'LocalSystem');
  assert.equal(tag(account({ account: 'LocalSystem' }), 'username'), 'LocalSystem');
  assert.equal(tag(account('NT AUTHORITY\\LocalService'), 'username'), 'NT AUTHORITY\\LocalService');
  for (const logOnAs of ['LocalService', 'NetworkService', 'LocalSystem', { account: 'LocalService', password: 'ignored' }]) {
    assert.ok(!account(logOnAs).includes('<prompt>'), JSON.stringify(logOnAs));
    assert.ok(!account(logOnAs).includes('<password>'));
    assert.equal(winsw.installCredentials({ logOnAs }), undefined);
  }
});

test('group managed service accounts have no password and never prompt', () => {
  const xml = account({ domain: 'corp', account: 'gmsa$', allowservicelogon: true });
  assert.equal(tag(xml, 'username'), 'corp\\gmsa$');
  assert.equal(tag(xml, 'allowservicelogon'), 'true');
  assert.ok(!xml.includes('<prompt>'));
  assert.equal(winsw.installCredentials({ logOnAs: { account: 'corp\\gmsa$', password: 'ignored' } }), undefined);
});

test('a user account without a password is asked for when installing', () => {
  for (const logOnAs of ['corp\\bob', { account: 'bob', domain: 'corp' }, { user: 'corp\\bob' }, { username: 'corp\\bob', password: null }]) {
    const xml = account(logOnAs);
    assert.equal(tag(xml, 'username'), 'corp\\bob', JSON.stringify(logOnAs));
    assert.equal(tag(xml, 'prompt'), 'dialog');
    assert.equal(winsw.installCredentials({ logOnAs }), undefined);
  }
});

test('the prompt can be a console prompt, or ask for the user name too', () => {
  assert.equal(tag(account({ account: 'corp\\bob', prompt: 'console' }), 'prompt'), 'console');
  const both = account({ prompt: 'dialog' });
  assert.equal(tag(both, 'prompt'), 'dialog');
  assert.ok(!both.includes('<username>'));
  assert.equal(tag(account({}), 'prompt'), 'dialog');
  assert.throws(() => account({ account: 'bob', prompt: 'telepathy' }), /logOnAs\.prompt/);
});

test('user names are completed with the domain unless they carry one', () => {
  assert.equal(tag(account({ account: 'bob', domain: 'corp' }), 'username'), 'corp\\bob');
  assert.equal(tag(account({ account: 'bob@corp.local', domain: 'ignored' }), 'username'), 'bob@corp.local');
  assert.equal(tag(account({ account: '.\\bob', domain: 'ignored' }), 'username'), '.\\bob');
  assert.equal(tag(account({ account: '  bob  ' }), 'username'), 'bob');
});

test('a password given by the program is never written to the configuration file', async t => {
  const logOnAs = { domain: 'corp', account: 'bob', password: 'S3cret & <sharp>', allowservicelogon: true };
  const xml = account(logOnAs);
  assert.equal(tag(xml, 'username'), 'corp\\bob');
  assert.equal(tag(xml, 'allowservicelogon'), 'true');
  assert.ok(!xml.includes('<prompt>'), 'no prompt when the password is known');
  assert.ok(!xml.includes('password'));
  assert.ok(!xml.includes('S3cret'));
  assert.deepEqual(winsw.installCredentials({ logOnAs }), { user: 'corp\\bob', password: 'S3cret & <sharp>' });

  const { svc, calls } = recorded(t, logOnAs);
  await svc.install();
  assert.deepEqual(calls, [['install', '--username', 'corp\\bob', '--password', 'S3cret & <sharp>']]);
  assert.ok(!fs.readFileSync(svc.xmlPath, 'utf8').includes('S3cret'));
});

test('an empty password is a password', async t => {
  const logOnAs = { account: 'bob', password: '' };
  assert.ok(!account(logOnAs).includes('<prompt>'));
  const { svc, calls } = recorded(t, logOnAs);
  await svc.install();
  assert.deepEqual(calls, [['install', '--username', 'bob', '--password', '']]);
});

test('a password without an account still prompts', () => {
  assert.equal(tag(account({ password: 'orphan' }), 'prompt'), 'dialog');
  assert.equal(winsw.installCredentials({ logOnAs: { password: 'orphan' } }), undefined);
});

test('no credentials are passed for prompting and built-in accounts', async t => {
  for (const logOnAs of [undefined, 'LocalService', 'corp\\bob', { account: 'corp\\gmsa$' }, { prompt: 'console' }]) {
    const { svc, calls } = recorded(t, logOnAs);
    await svc.install();
    assert.deepEqual(calls, [['install']], JSON.stringify(logOnAs));
    t.mock.restoreAll();
  }
});

test('credentials given to install() win over logOnAs', async t => {
  const { svc, calls } = recorded(t, { account: 'corp\\bob', password: 'from config' });
  await svc.install({ user: 'corp\\alice', password: 'from install' });
  await svc.install({ password: 'only the password' });
  await svc.install({ user: 'corp\\alice' });
  assert.deepEqual(calls, [
    ['install', '--username', 'corp\\alice', '--password', 'from install'],
    ['install', '--username', 'corp\\bob', '--password', 'only the password'],
    ['install', '--username', 'corp\\alice', '--password', ''],
  ]);
});

test('refresh keeps the password out of the file too', async t => {
  const { svc, calls } = recorded(t, { account: 'corp\\bob', password: 'S3cret' });
  await svc.install();
  await svc.refresh({ description: 'changed' });
  const xml = fs.readFileSync(svc.xmlPath, 'utf8');
  assert.equal(tag(xml, 'description'), 'changed');
  assert.ok(!xml.includes('S3cret'));
  assert.deepEqual(calls[1], ['refresh']);
});
