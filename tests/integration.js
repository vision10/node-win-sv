'use strict';

// End to end test: installs a real Windows service, exercises it and removes it.
// Needs administrator rights, when started from a normal terminal it asks for elevation once (UAC).
//   npm run test:service

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { execFile } = require('child_process');

const win = require('../index');
const { script, waitFor } = require('./helpers');

const PORT = 39417;
const SOURCE = 'win-sv integration test';
const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function runCli(args) {
  return new Promise(resolve => {
    execFile(process.execPath, [cli, ...args], { windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function ask() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, timeout: 2000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function main(log) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sv-it-'));
  const svc = new win.Service({
    id: 'win-sv-integration',
    name: 'win-sv integration test',
    description: 'Temporary service created by the win-sv tests',
    script,
    scriptOptions: ['hello world', '--flag=1'],
    env: { PORT, WINSV_GREETING: 'hi & <bye>' },
    winswDest: dest,
    startmode: 'manual',
    resetfailure: 60,
    onfailure: [{ action: 'restart', delay: 1 }],
  });
  const events = [];
  for (const name of ['install', 'start', 'stop', 'restart', 'refresh', 'uninstall']) {
    svc.on(name, () => events.push(name));
  }
  const step = async (name, fn) => {
    const started = Date.now();
    await fn();
    log(`ok - ${name} (${Date.now() - started} ms)`);
  };

  try {
    await step('install', async () => {
      await svc.install();
      assert.equal(await svc.status(), 'Inactive (stopped)');
      assert.equal(await svc.isInstalled(), true);
      assert.equal(await svc.isRunning(), false);
    });

    let first;
    await step('start, arguments and environment reach the script', async () => {
      await svc.start();
      assert.equal(await svc.status(), 'Active (running)');
      first = await waitFor('the server', ask);
      assert.deepEqual(first.args, ['hello world', '--flag=1']);
      assert.equal(first.greeting, 'hi & <bye>');
      assert.equal(first.cwd.toLowerCase(), path.join(__dirname, 'fixtures').toLowerCase());
    });

    let second;
    await step('Windows restarts the service after a crash', async () => {
      await win.process.kill(first.pid, true);
      second = await waitFor('the service to come back', async () => {
        const info = await ask();
        return info.pid !== first.pid && info;
      });
      assert.equal(await svc.status(), 'Active (running)');
    });

    await step('restart', async () => {
      await svc.restart();
      const third = await waitFor('the restarted server', async () => {
        const info = await ask();
        return info.pid !== second.pid && info;
      });
      assert.ok(third.pid);
    });

    await step('refresh applies configuration changes', async () => {
      await svc.refresh({ description: 'refreshed description' });
      const out = await win.cmd.run('sc', ['qdescription', svc.id]);
      assert.match(out, /refreshed description/);
    });

    await step('process.list sees the wrapper', async () => {
      const tasks = await win.process.list(svc.id);
      assert.equal(tasks.length, 1);
    });

    await step('stop', async () => {
      await svc.stop();
      assert.equal(await svc.status(), 'Inactive (stopped)');
      await assert.rejects(ask());
    });

    await step('process.start / restart / stop by service name', async () => {
      await win.process.start(svc.id);
      const before = await waitFor('the server', ask);
      await win.process.restart(svc.id);
      const after = await waitFor('the server', ask);
      assert.notEqual(after.pid, before.pid);
      await win.process.stop(svc.id);
      assert.equal(await svc.status(), 'Inactive (stopped)');
      // restart also starts a stopped service
      await win.process.restart(svc.id);
      assert.equal(await svc.status(), 'Active (running)');
      await svc.stop();
    });

    await step('install over an installed service fails, the service is untouched', async () => {
      await assert.rejects(svc.install(), error => error.code === 1073);
      assert.equal(await svc.status(), 'Inactive (stopped)');
    });

    await step('uninstall a running service and remove its files', async () => {
      await svc.start();
      await svc.uninstall(true);
      assert.equal(await svc.status(), 'NonExistent');
      assert.equal(fs.existsSync(svc.winswPath), false);
      await assert.rejects(win.cmd.run('sc', ['query', svc.id]));
    });

    await step('events', async () => {
      assert.deepEqual([...new Set(events)].sort(), ['install', 'refresh', 'restart', 'start', 'stop', 'uninstall']);
    });

    await step('command line: install --start, status, restart, uninstall --remove-files', async () => {
      const common = ['--script', script, '--id', 'win-sv-integration-cli', '--dest', dest];
      const install = await runCli(['install', ...common, '--env', 'PORT=' + PORT, '--startmode', 'manual', '--restart-delay', '1', '--start', '--', 'from the cli']);
      assert.equal(install.code, 0, install.stderr);
      assert.equal((await runCli(['status', ...common])).stdout, 'Active (running)');
      const info = await waitFor('the server', ask);
      assert.deepEqual(info.args, ['from the cli']);

      assert.equal((await runCli(['restart', ...common])).code, 0);
      await waitFor('the restarted server', async () => (await ask()).pid !== info.pid);
      assert.equal((await runCli(['stop', ...common])).code, 0);
      assert.equal((await runCli(['status', ...common])).stdout, 'Inactive (stopped)');
      assert.equal((await runCli(['start', ...common])).code, 0);

      const uninstall = await runCli(['uninstall', ...common, '--remove-files']);
      assert.equal(uninstall.code, 0, uninstall.stderr);
      assert.equal((await runCli(['status', ...common])).stdout, 'NonExistent');
      assert.deepEqual(fs.readdirSync(dest), []);
    });

    await step('event log', async () => {
      const logger = new win.EventLogger(SOURCE);
      await logger.registerEventSource();
      assert.equal(await logger.isRegistered(), true);
      await logger.info('multi line\nmessage with "quotes" & <symbols>', 7);
      await logger.warn('warning from the win-sv tests', 20);
      await logger.error('error from the win-sv tests', 30);
      await logger.success('success from the win-sv tests');
      const query = `*[System[Provider[@Name="${SOURCE}"]]]`;
      const out = await win.cmd.run('wevtutil', ['qe', 'Application', '/c:4', '/rd:true', '/f:text', '/q:' + query]);
      assert.match(out, /message with "quotes" & <symbols>/);
      assert.match(out, /warning from the win-sv tests/);
      assert.match(out, /error from the win-sv tests/);
      assert.match(out, /success from the win-sv tests/);
      for (const id of [7, 20, 30, 1000]) { assert.match(out, new RegExp(`Event ID: ${id}\\s`)) }
      await win.cmd.run('reg', ['delete', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\' + SOURCE, '/f']);
    });
  } finally {
    await svc.uninstall(true).catch(error => log('cleanup failed: ' + error.message));
    await runCli(['uninstall', '--script', script, '--id', 'win-sv-integration-cli', '--dest', dest, '--remove-files']);
    await win.cmd.run('reg', ['delete', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\' + SOURCE, '/f']).catch(() => {});
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function run() {
  const logFile = process.argv[2];
  if (logFile) {
    // elevated child: there is no console to write to, report through the log file
    const log = line => fs.appendFileSync(logFile, line + '\n');
    try {
      await main(log);
      log('PASS');
    } catch (error) {
      log('FAIL\n' + error.stack);
      process.exitCode = 1;
    }
  } else if (await win.cmd.isElevated()) {
    await main(console.log);
    console.log('PASS');
  } else {
    const file = path.join(os.tmpdir(), `win-sv-integration-${process.pid}.log`);
    fs.writeFileSync(file, '');
    console.log('Not elevated, asking for administrator rights...');
    try {
      await win.cmd.elevate(process.execPath, [__filename, file]);
    } finally {
      console.log(fs.readFileSync(file, 'utf8'));
      fs.rmSync(file, { force: true });
    }
  }
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
