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
  }

  /** Resolves true when the source is already registered for this log. */
  isRegistered() {
    const log = this.eventLog === 'SYSTEM' ? 'System' : 'Application';
    return cmd.run('reg', ['query', `${KEY}\\${log}\\${this.source}`]).then(() => true, () => false);
  }

  /**
   * Registers the event source. Requires elevation once (UAC prompt),
   * afterwards writing to the APPLICATION log does not need administrator rights.
   */
  async registerEventSource() {
    if (!(await this.isRegistered())) {
      // eventcreate registers the source itself when it runs as administrator
      const args = eventArgs(this.eventLog, this.source, 'INFORMATION', `Event source "${this.source}" registered.`, 1);
      await ((await cmd.isElevated()) ? cmd.run('eventcreate', args) : cmd.elevate('eventcreate', args));
    }
    this.emit('register');
    return true;
  }

  write(type, message, code) {
    message = String(message === undefined || message === null ? '' : message).trim();
    if (!message) { return Promise.resolve('') }
    return cmd.execute('eventcreate', eventArgs(this.eventLog, this.source, type, message, code));
  }

  info(message, code) { return this.write('INFORMATION', message, code) }
  warn(message, code) { return this.write('WARNING', message, code) }
  error(message, code) { return this.write('ERROR', message, code) }
  success(message, code) { return this.write('SUCCESS', message, code) }
}
