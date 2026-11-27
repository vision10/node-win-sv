'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Script used as the service in the tests, an HTTP server describing its own process. */
const script = path.join(__dirname, 'fixtures', 'server.js');

/** Creates a temporary folder removed when the test ends. */
function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** Content of the first `<name>` element. */
function tag(xml, name) {
  return (xml.match(new RegExp(`<${name}>(.*)</${name}>`)) || [])[1];
}

/** The wrapper under test: the bundled winsv, or the executable named by WIN_SV_EXE. */
const wrapper = require('../lib/winsw').wrapperExe();
const isWinSW = require('../lib/winsw').isWinSW(wrapper);

/**
 * For one test the wrapper is a file standing for WinSW: whatever is not winsv is driven like it,
 * and the commands are recorded by the test, never run.
 */
function asWinSW(t) {
  const file = path.join(tmpDir(t), 'WinSW.exe');
  fs.writeFileSync(file, 'stands for WinSW');
  const before = process.env.WIN_SV_EXE;
  process.env.WIN_SV_EXE = file;
  t.after(() => {
    if (before === undefined) { delete process.env.WIN_SV_EXE } else { process.env.WIN_SV_EXE = before }
  });
  return file;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(what, check, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) { return value }
    } catch (error) { last = error }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}` + (last ? `: ${last.message}` : ''));
}

module.exports = { script, tmpDir, tag, sleep, waitFor, wrapper, isWinSW, asWinSW };
