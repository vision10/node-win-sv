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

module.exports = { script, tmpDir, tag, sleep, waitFor };
