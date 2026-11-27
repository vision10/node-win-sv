'use strict';

const { EventEmitter } = require('events');
const cmd = require('./cmd');

const EVENT_LOGS = ['APPLICATION', 'SYSTEM'];
const KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\EventLog';

function eventArgs(log, source, type, message, id) {
  id = Math.trunc(Number(id));
  // eventcreate only accepts ids from 1 to 1000
  if (!(id >= 1 && id <= 1000)) { id = 1000 }
  return ['/L', log, '/T', type, '/ID', String(id), '/SO', source, '/D', message];
}

module.exports = class EventLogger extends EventEmitter {
  /**
   * @param {string|object} [config] source name, or `{ source, eventLog|isSystem }`
   * @param {boolean} [isSystem] write to the SYSTEM log instead of APPLICATION
   */
  constructor(config, isSystem) {
    super();
    if (typeof config === 'string') { config = { source: config, isSystem } }
    config = config || {};
    this.source = String(config.source || 'Node.js').trim();
    this.eventLog = config.eventLog || config.type || (config.isSystem === true ? 'SYSTEM' : 'APPLICATION');
  }

  get eventLog() { return this.logname }
  set eventLog(value) {
    value = String(value || '').trim().toUpperCase();
    this.logname = EVENT_LOGS.includes(value) ? value : 'APPLICATION';
    this.registered = undefined;
  }

  /** Resolves true when the source is already registered for this log. */
  async isRegistered() {
    if (this.registered) { return true }
    const log = this.eventLog === 'SYSTEM' ? 'System' : 'Application';
    // decided on the exit code of `reg query`
    this.registered = await cmd.run(cmd.sys('reg.exe'), ['query', `${KEY}\\${log}\\${this.source}`]).then(() => true, () => false);
    return this.registered;
  }

  /**
   * Registers the event source. Requires elevation once (UAC prompt),
   * afterwards writing to the APPLICATION log does not need administrator rights.
   */
  async registerEventSource() {
    if (!(await this.isRegistered())) {
      // eventcreate registers the source itself when it runs as administrator
      const args = eventArgs(this.eventLog, this.source, 'INFORMATION', `Event source "${this.source}" registered.`, 1);
      await cmd.admin(cmd.sys('eventcreate.exe'), args);
      this.registered = true;
    }
    this.emit('register');
    return true;
  }

  async write(type, message, code) {
    message = String(message === undefined || message === null ? '' : message).trim();
    if (!message) { return '' }
    const args = eventArgs(this.eventLog, this.source, type, message, code);
    // Only a registered source of the APPLICATION log can be written to without administrator rights.
    // Knowing that up front avoids reading the error text, which depends on the display language.
    const open = this.eventLog === 'APPLICATION' && await this.isRegistered();
    const out = await (open ? cmd.run(cmd.sys('eventcreate.exe'), args) : cmd.admin(cmd.sys('eventcreate.exe'), args));
    this.registered = true;
    return out;
  }

  info(message, code) { return this.write('INFORMATION', message, code) }
  warn(message, code) { return this.write('WARNING', message, code) }
  error(message, code) { return this.write('ERROR', message, code) }
  success(message, code) { return this.write('SUCCESS', message, code) }
}
