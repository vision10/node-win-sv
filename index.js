'use strict';

if (process.platform !== 'win32') {
  throw new Error('win-sv is only supported on Windows.');
}

module.exports = {
  Service: require('./lib/service'),
  EventLogger: require('./lib/eventlog'),
  services: require('./lib/services'),
  process: require('./lib/process'),
  cmd: require('./lib/cmd'),
  generateXml: require('./lib/winsw').generateXml,
};
