'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const { script, sleep, waitFor, wrapper, isWinSW } = require('../helpers');

/** Runs an executable and resolves `{ code, stdout, stderr }`, whatever the exit code. */
function exec(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

/** Asks the fixture server listening on `port` about its process. */
function ask(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, timeout: 2000, agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk });
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

/** Waits for the server on `port` to answer, optionally from another process than `notPid`. */
function server(port, notPid) {
  return waitFor('the service to answer on port ' + port, async () => {
    const info = await ask(port);
    return info.pid !== notPid && info;
  });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'win-sv-acceptance-'));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

module.exports = { script, sleep, waitFor, wrapper, isWinSW, exec, ask, server, tmpDir, removeDir };
