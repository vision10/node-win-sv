'use strict';

// The WinSW configuration generated from the service options.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { generateXml } = require('../index');
const winsw = require('../lib/winsw');
const { toXml } = require('../lib/xml');
const { script, tag } = require('./helpers');

test('minimal configuration', () => {
  const xml = generateXml({ id: 'svc', script });
  assert.equal(tag(xml, 'id'), 'svc');
  assert.equal(tag(xml, 'executable'), process.execPath);
  assert.equal(tag(xml, 'arguments'), script);
  assert.equal(tag(xml, 'workingdirectory'), path.dirname(script));
  for (const optional of ['name', 'description', 'log', 'onfailure', 'serviceaccount', 'startmode']) {
    assert.ok(!xml.includes('<' + optional), optional);
  }
});

test('the file is one <service> element with Windows line endings', () => {
  const xml = generateXml({ id: 'svc', script, name: 'My service', description: 'does things' });
  assert.ok(xml.startsWith('<service>\r\n\t<id>svc</id>\r\n'));
  assert.ok(xml.endsWith('</service>\r\n'));
  assert.ok(!/[^\r]\n/.test(xml));
  assert.equal(tag(xml, 'name'), 'My service');
  assert.equal(tag(xml, 'description'), 'does things');
});

test('id falls back to name, id and script are required', () => {
  assert.equal(tag(generateXml({ name: 'my svc', script }), 'id'), 'my svc');
  assert.throws(() => generateXml({ script }), /id/);
  assert.throws(() => generateXml({ id: 'svc' }), /script/);
  assert.throws(() => generateXml(), /id/);
});

test('relative script and working directory are resolved', () => {
  const xml = generateXml({ id: 'svc', script: 'app/server.js', cwd: 'app/data' });
  assert.equal(tag(xml, 'arguments'), path.resolve('app/server.js'));
  assert.equal(tag(xml, 'workingdirectory'), path.resolve('app/data'));
  assert.equal(tag(generateXml({ id: 'svc', script, workingdirectory: 'C:\\data' }), 'workingdirectory'), 'C:\\data');
});

test('arguments are a single, correctly quoted command line', () => {
  const spaced = path.join(os.tmpdir(), 'my app', 'server.js');
  const xml = generateXml({
    id: 'svc',
    script: spaced,
    nodeOptions: ['--max-old-space-size=512'],
    scriptOptions: ['--port=9000', 'two words', 'say "hi"', 'C:\\dir with space\\'],
  });
  assert.equal(xml.match(/<arguments>/g).length, 1);
  assert.equal(
    tag(xml, 'arguments'),
    `--max-old-space-size=512 "${spaced}" --port=9000 "two words" "say \\"hi\\"" "C:\\dir with space\\\\"`
  );
});

test('string options are passed through untouched', () => {
  const xml = generateXml({ id: 'svc', script, execOptions: '--harmony  --trace-warnings', scriptOptions: '-a  -b' });
  assert.equal(tag(xml, 'arguments'), `--harmony  --trace-warnings ${script} -a  -b`);
});

test('quoteArg follows the Windows command line rules', () => {
  assert.equal(winsw.quoteArg('plain'), 'plain');
  assert.equal(winsw.quoteArg(42), '42');
  assert.equal(winsw.quoteArg(''), '""');
  assert.equal(winsw.quoteArg('a b'), '"a b"');
  assert.equal(winsw.quoteArg('a\tb'), '"a\tb"');
  assert.equal(winsw.quoteArg('a\\b'), 'a\\b');
  assert.equal(winsw.quoteArg('a\\"b'), '"a\\\\\\"b"');
  assert.equal(winsw.quoteArg('a b\\'), '"a b\\\\"');
});

test('another executable, with or without a script', () => {
  const python = generateXml({ id: 'svc', execPath: 'python', script: 'C:\\app\\main.py', execOptions: ['-u'] });
  assert.equal(tag(python, 'executable'), 'python');
  assert.equal(tag(python, 'arguments'), '-u C:\\app\\main.py');

  const exe = generateXml({ id: 'svc', execPath: 'C:\\tools\\app.exe' });
  assert.equal(tag(exe, 'executable'), 'C:\\tools\\app.exe');
  assert.ok(!exe.includes('<arguments>'));
  assert.ok(!exe.includes('<workingdirectory>'));
});

test('values are escaped', () => {
  const xml = generateXml({ id: 'svc', script, description: 'a < b & c > d', env: { X: 'say "hi" & <bye>\nline' } });
  assert.equal(tag(xml, 'description'), 'a &lt; b &amp; c &gt; d');
  assert.ok(xml.includes('<env name="X" value="say &quot;hi&quot; &amp; &lt;bye&gt;&#10;line"/>'));
});

test('xml writer', () => {
  assert.equal(toXml({ tag: 'a' }), '<a/>\r\n');
  assert.equal(toXml({ tag: 'a', text: 0 }), '<a>0</a>\r\n');
  assert.equal(toXml({ tag: 'a', text: false }), '<a>false</a>\r\n');
  assert.equal(toXml({ tag: 'a', attrs: { x: 1, skipped: undefined, y: 'z' } }), '<a x="1" y="z"/>\r\n');
  assert.equal(toXml({ tag: 'a', children: [{ tag: 'b', children: [{ tag: 'c', text: 'd' }] }] }), '<a>\r\n\t<b>\r\n\t\t<c>d</c>\r\n\t</b>\r\n</a>\r\n');
});

test('env accepts an object or a list', () => {
  const expected = '<env name="A" value="1"/>';
  assert.ok(generateXml({ id: 'svc', script, env: { A: 1 } }).includes(expected));
  assert.ok(generateXml({ id: 'svc', script, env: [{ name: 'A', value: '1' }] }).includes(expected));
  const xml = generateXml({ id: 'svc', script, env: { A: 1, B: '', SKIPPED: undefined } });
  assert.equal(xml.match(/<env /g).length, 2);
  assert.ok(xml.includes('<env name="B" value=""/>'));
});

test('dependencies accept a list or a comma separated string', () => {
  for (const depend of [['Eventlog', 'W32Time'], 'Eventlog, W32Time']) {
    const xml = generateXml({ id: 'svc', script, depend });
    assert.ok(xml.includes('<depend>Eventlog</depend>'));
    assert.ok(xml.includes('<depend>W32Time</depend>'));
  }
});

test('failure actions are delegated to the service control manager', () => {
  const xml = generateXml({
    id: 'svc', script, resetfailure: 3600,
    onfailure: [{ action: 'restart', delay: 10 }, { action: 'restart', delay: '1 min' }, 'none'],
  });
  assert.ok(xml.includes('<onfailure action="restart" delay="10 sec"/>'));
  assert.ok(xml.includes('<onfailure action="restart" delay="1 min"/>'));
  assert.ok(xml.includes('<onfailure action="none"/>'));
  assert.equal(tag(xml, 'resetfailure'), '3600 sec');
  assert.equal(tag(generateXml({ id: 'svc', script, resetfailure: '1 hour' }), 'resetfailure'), '1 hour');
});

test('a single failure action, a zero delay and invalid actions', () => {
  assert.ok(generateXml({ id: 'svc', script, onfailure: 'restart' }).includes('<onfailure action="restart"/>'));
  assert.ok(generateXml({ id: 'svc', script, onfailure: { action: 'Reboot', delay: 0 } }).includes('<onfailure action="reboot" delay="0 sec"/>'));
  assert.throws(() => generateXml({ id: 'svc', script, onfailure: [{ action: 'explode' }] }), /onfailure/);
  assert.throws(() => generateXml({ id: 'svc', script, onfailure: ['none', 'none', 'none', 'none'] }), /at most 3/);
});

test('service account', () => {
  const account = cfg => generateXml({ id: 'svc', script, logOnAs: cfg });
  assert.ok(!account(true).includes('serviceaccount'));
  assert.equal(tag(account('LocalService'), 'username'), 'NT AUTHORITY\\LocalService');
  assert.equal(tag(account('networkservice'), 'username'), 'NT AUTHORITY\\networkservice');
  assert.equal(tag(account({}), 'username'), 'LocalSystem');
  assert.equal(tag(account({ account: 'bob@corp.local', domain: 'ignored' }), 'username'), 'bob@corp.local');
  assert.equal(tag(account({ account: '.\\bob' }), 'username'), '.\\bob');

  const user = account({ domain: 'corp', account: 'bob', password: 'p&ss', allowservicelogon: true });
  assert.equal(tag(user, 'username'), 'corp\\bob');
  assert.equal(tag(user, 'password'), 'p&amp;ss');
  assert.equal(tag(user, 'allowservicelogon'), 'true');

  const gmsa = account({ domain: 'corp', account: 'gmsa$' });
  assert.equal(tag(gmsa, 'username'), 'corp\\gmsa$');
  assert.ok(!gmsa.includes('<password>'));

  assert.equal(tag(account({ prompt: 'dialog' }), 'prompt'), 'dialog');
  assert.throws(() => account({ prompt: 'telepathy' }), /prompt/);
});

test('log modes', () => {
  const log = cfg => generateXml({ id: 'svc', script, log: cfg });
  assert.ok(log('reset').includes('<log mode="reset"/>'));
  assert.ok(log({}).includes('<log mode="append"/>'));

  const size = log({ mode: 'roll-by-size', keepFiles: 3 });
  assert.equal(tag(size, 'sizeThreshold'), '10240');
  assert.equal(tag(size, 'keepFiles'), '3');
  assert.ok(!size.includes('<pattern>'));

  const time = log({ mode: 'roll-by-time' });
  assert.equal(tag(time, 'pattern'), 'yyyyMMdd');
  assert.ok(!time.includes('<sizeThreshold>'));

  const both = log({ mode: 'roll-by-size-time', sizeThreshold: 512, pattern: 'yyyyMM', autoRollAtTime: '00:00:00' });
  assert.equal(tag(both, 'sizeThreshold'), '512');
  assert.equal(tag(both, 'pattern'), 'yyyyMM');
  assert.equal(tag(both, 'autoRollAtTime'), '00:00:00');
  assert.ok(!both.includes('<keepFiles>'));

  assert.throws(() => log('sideways'), /log\.mode/);
  assert.equal(tag(generateXml({ id: 'svc', script, logpath: 'C:\\logs' }), 'logpath'), 'C:\\logs');
});

test('start mode, priority and timeouts', () => {
  const xml = generateXml({
    id: 'svc', script, startmode: 'Manual', priority: 'BelowNormal', stoptimeout: 30, delayedAutoStart: true,
    preshutdown: true, preshutdownTimeout: '5 min',
  });
  assert.equal(tag(xml, 'startmode'), 'manual');
  assert.equal(tag(xml, 'priority'), 'belownormal');
  assert.equal(tag(xml, 'stoptimeout'), '30 sec');
  assert.equal(tag(xml, 'delayedAutoStart'), 'true');
  assert.equal(tag(xml, 'preshutdown'), 'true');
  assert.equal(tag(xml, 'preshutdownTimeout'), '5 min');
  assert.throws(() => generateXml({ id: 'svc', script, priority: 'fastest' }), /priority/);
  assert.throws(() => generateXml({ id: 'svc', script, startmode: 'sometimes' }), /startmode/);
});

test('switches are only written when they differ from the WinSW default', () => {
  const off = generateXml({ id: 'svc', script, interactive: false, beeponshutdown: false, autoRefresh: true, delayedAutoStart: false });
  for (const name of ['interactive', 'beeponshutdown', 'autoRefresh', 'delayedAutoStart']) {
    assert.ok(!off.includes('<' + name), name);
  }
  const on = generateXml({ id: 'svc', script, interactive: true, beeponshutdown: true, autoRefresh: false, securitydescriptor: 'D:(A;;CC;;;SY)' });
  assert.equal(tag(on, 'interactive'), 'true');
  assert.equal(tag(on, 'beeponshutdown'), 'true');
  assert.equal(tag(on, 'autoRefresh'), 'false');
  assert.equal(tag(on, 'securityDescriptor'), 'D:(A;;CC;;;SY)');
});

test('stop arguments switch to startarguments', () => {
  const xml = generateXml({ id: 'svc', execPath: 'catalina.bat', startarguments: 'jpda run', stoparguments: ['stop'] });
  assert.equal(tag(xml, 'executable'), 'catalina.bat');
  assert.equal(tag(xml, 'startarguments'), 'jpda run');
  assert.equal(tag(xml, 'stoparguments'), 'stop');
  assert.ok(!xml.includes('<arguments>'));

  const node = generateXml({ id: 'svc', script, stopexecutable: 'C:\\app\\stop.cmd', stoparguments: ['now', 'two words'] });
  assert.equal(tag(node, 'startarguments'), script);
  assert.equal(tag(node, 'stopexecutable'), 'C:\\app\\stop.cmd');
  assert.equal(tag(node, 'stoparguments'), 'now "two words"');
});

test('hook commands', () => {
  const xml = generateXml({
    id: 'svc', script,
    prestart: { executable: 'cmd', arguments: ['/c', 'echo starting'], stdoutPath: 'NUL' },
    poststop: { executable: 'C:\\app\\cleanup.exe' },
  });
  assert.ok(xml.includes('<prestart>\r\n\t\t<executable>cmd</executable>\r\n\t\t<arguments>/c "echo starting"</arguments>\r\n\t\t<stdoutPath>NUL</stdoutPath>\r\n\t</prestart>'));
  assert.ok(xml.includes('<poststop>\r\n\t\t<executable>C:\\app\\cleanup.exe</executable>\r\n\t</poststop>'));
  assert.throws(() => generateXml({ id: 'svc', script, prestop: { arguments: 'x' } }), /prestop\.executable/);
});

test('downloads', () => {
  const xml = generateXml({
    id: 'svc', script,
    download: [
      { from: 'https://example.com/a.dat', to: '%BASE%\\a.dat' },
      { from: 'https://example.com/b.dat', to: '%BASE%\\b.dat', failOnError: true, auth: 'basic', username: 'bob', proxy: 'http://proxy:80/' },
    ],
  });
  assert.ok(xml.includes('<download from="https://example.com/a.dat" to="%BASE%\\a.dat"/>'));
  assert.ok(xml.includes('<download from="https://example.com/b.dat" to="%BASE%\\b.dat" failOnError="true" proxy="http://proxy:80/" auth="basic" user="bob" password=""/>'));
  assert.equal(generateXml({ id: 'svc', script, download: { from: 'a', to: 'b' } }).match(/<download /g).length, 1);
  assert.throws(() => generateXml({ id: 'svc', script, download: { from: 'a' } }), /download/);
});
