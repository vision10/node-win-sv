// The package can be imported as well as required.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import win, { Service, EventLogger, services, process as processes, cmd, generateXml } from 'win-sv';

const require = createRequire(import.meta.url);

test('named and default exports match the CommonJS module', () => {
  const cjs = require('win-sv');
  assert.equal(win, cjs);
  assert.deepEqual(
    { Service, EventLogger, services, process: processes, cmd, generateXml },
    { Service: cjs.Service, EventLogger: cjs.EventLogger, services: cjs.services, process: cjs.process, cmd: cjs.cmd, generateXml: cjs.generateXml }
  );
  assert.deepEqual(Object.keys(cjs).sort(), ['EventLogger', 'Service', 'cmd', 'generateXml', 'process', 'services']);
});

test('the package resolves by name, with its types and metadata', () => {
  const pkg = require('win-sv/package.json');
  assert.equal(pkg.name, 'win-sv');
  assert.equal(require.resolve('win-sv'), require.resolve('../index.js'));
  assert.equal(pkg.types, 'index.d.ts');
});

test('imported classes work', () => {
  const svc = new Service({ id: 'svc', script: 'C:\\app\\server.js' });
  assert.equal(svc.id, 'svc');
  assert.match(generateXml(svc.config), /<id>svc<\/id>/);
  assert.equal(new EventLogger('src').source, 'src');
});
