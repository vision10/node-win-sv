'use strict';

const cmd = require('./cmd');

/** Parses one line of `tasklist /FO CSV` output. */
function parseCsvLine(line) {
  const cells = [];
  const re = /"((?:[^"]|"")*)"|([^,]+)/g;
  let match;
  while ((match = re.exec(line))) {
    cells.push(match[1] !== undefined ? match[1].replace(/""/g, '"') : match[2]);
  }
  return cells;
}

function parseTasklist(output) {
  const lines = output.split(/\r?\n/).filter(line => line.trim().startsWith('"'));
  if (lines.length < 2) { return [] }
  const head = parseCsvLine(lines.shift()).map(name => name.replace(/ /g, ''));
  return lines.map(line => {
    const row = {};
    parseCsvLine(line).forEach((cell, i) => { row[head[i]] = cell });
    return row;
  });
}

module.exports = {
  parseTasklist,

  /** Starts a Windows service by name (`net start`). */
  start(serviceName) {
    return cmd.execute('net', ['start', serviceName]);
  },
  /** Stops a Windows service by name (`net stop`). */
  stop(serviceName) {
    return cmd.execute('net', ['stop', serviceName]);
  },
  async restart(serviceName) {
    try {
      await this.stop(serviceName);
    } catch (error) {
      // NET HELPMSG 3521: the service is not started
      if (!/3521/.test(error.message)) { throw error }
    }
    return this.start(serviceName);
  },

  /**
   * Kills processes (`taskkill`).
   * @param {number|string} pidOrName process id or image name (`node.exe`), a name can match several processes
   * @param {string|boolean} [filter] taskkill filter (`STATUS eq NOT RESPONDING`), or `force` when a boolean
   * @param {boolean} [force]
   */
  kill(pidOrName, filter, force) {
    if (typeof filter === 'boolean') { [filter, force] = [undefined, filter] }
    if (pidOrName === undefined || pidOrName === null || pidOrName === '') {
      if (!filter) { return Promise.reject(new Error('A pid, an image name or a filter is required.')) }
      pidOrName = '*';
    }
    const isPid = typeof pidOrName === 'number' || /^\d+$/.test(pidOrName);
    const args = [isPid ? '/PID' : '/IM', String(pidOrName)];
    if (filter) { args.push('/FI', filter) }
    if (force === true) { args.push('/F') }
    return cmd.execute('taskkill', args);
  },

  /**
   * Lists running processes (`tasklist`).
   * @param {string|RegExp|function} [filter] text contained in the image name, a RegExp tested against it, or a predicate
   * @param {boolean} [verbose] include Status, UserName, CPUTime and WindowTitle (slower)
   */
  async list(filter, verbose) {
    const args = ['/FO', 'CSV'];
    if (verbose === true) { args.push('/V') }
    const tasks = parseTasklist(await cmd.run('tasklist', args));
    if (!filter) { return tasks }

    const name = task => task.ImageName || Object.values(task)[0] || '';
    if (typeof filter === 'function') { return tasks.filter(filter) }
    if (filter instanceof RegExp) { return tasks.filter(task => filter.test(name(task))) }
    const text = String(filter).toLowerCase();
    return tasks.filter(task => name(task).toLowerCase().includes(text));
  },
};
