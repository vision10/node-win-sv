'use strict';

const cmd = require('./cmd');
const services = require('./services');

const TASKKILL_NOT_FOUND = 128;

// WMI property names and values do not depend on the display language.
const QUERY = `
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object { @{
  name = $_.Name; pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; sessionId = [int]$_.SessionId
  memory = [long]$_.WorkingSetSize; path = $_.ExecutablePath; commandLine = $_.CommandLine
  startTime = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }
} })
`;

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

/**
 * Parses `tasklist /FO CSV [/V]`. Columns are read by position because their titles are translated:
 * image name, pid, session name, session number, memory, then with /V: status, user, cpu time, window title.
 */
function parseTasklist(output) {
  const lines = String(output).split(/\r?\n/).filter(line => line.trim().startsWith('"'));
  // the first line holds the column titles
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const task = {
      name: cells[0],
      pid: Number(cells[1]),
      sessionId: Number(cells[3]),
      // "1,736 K": thousands separators differ per language, the unit is always kilobytes
      memory: Number(String(cells[4] || '').replace(/\D/g, '')) * 1024,
      sessionName: cells[2] || '',
    };
    if (cells.length > 5) {
      Object.assign(task, { status: cells[5], user: cells[6], cpuTime: cells[7], windowTitle: cells[8] });
    }
    return task;
  });
}

async function tasklist(verbose) {
  const args = ['/FO', 'CSV'];
  if (verbose) { args.push('/V') }
  return parseTasklist(await cmd.run(cmd.sys('tasklist.exe'), args));
}

async function query() {
  return JSON.parse(await cmd.powershell(QUERY) || '[]').map(row => ({
    name: row.name,
    pid: row.pid,
    ppid: row.ppid,
    sessionId: row.sessionId,
    memory: row.memory,
    path: row.path || '',
    commandLine: row.commandLine || '',
    startTime: row.startTime || '',
  }));
}

/** true when the target of a kill is still running */
async function targetExists(pidOrName, isPid) {
  const filter = isPid ? `PID eq ${pidOrName}` : `IMAGENAME eq ${pidOrName}`;
  const out = await cmd.run(cmd.sys('tasklist.exe'), ['/FO', 'CSV', '/NH', '/FI', filter]).catch(() => '');
  return out.split(/\r?\n/).some(line => line.trim().startsWith('"'));
}

module.exports = {
  parseTasklist,

  /** Same as `services.start`, `services.stop` and `services.restart`. */
  start: name => services.start(name),
  stop: name => services.stop(name),
  restart: name => services.restart(name),

  /**
   * Kills processes (`taskkill`). A forced kill that fails for lack of rights is retried as administrator.
   * @param {number|string} pidOrName process id or image name (`node.exe`), a name can match several processes
   * @param {string|boolean} [filter] taskkill filter (`STATUS eq NOT RESPONDING`), or `force` when a boolean
   * @param {boolean} [force]
   */
  async kill(pidOrName, filter, force) {
    if (typeof filter === 'boolean') { [filter, force] = [undefined, filter] }
    const hasTarget = !(pidOrName === undefined || pidOrName === null || pidOrName === '');
    if (!hasTarget && !filter) { throw new Error('A pid, an image name or a filter is required.') }
    if (!hasTarget) { pidOrName = '*' }

    const isPid = typeof pidOrName === 'number' || /^\d+$/.test(pidOrName);
    const args = [isPid ? '/PID' : '/IM', String(pidOrName)];
    if (filter) { args.push('/FI', filter) }
    if (force === true) { args.push('/F') }

    const file = cmd.sys('taskkill.exe');
    try {
      return await cmd.run(file, args);
    } catch (error) {
      // Without /F a failure usually means the process ignored the request, elevation would not help.
      // With it, a process that exists and could not be killed is one this user has no rights on.
      const denied = force === true && hasTarget && !filter && error.code !== TASKKILL_NOT_FOUND
        && !(await cmd.isElevated()) && await targetExists(pidOrName, isPid);
      if (!denied) { throw error }
      return cmd.elevate(file, args);
    }
  },

  /**
   * Lists running processes: `{ name, pid, ppid, sessionId, memory, path, commandLine, startTime }`, memory in bytes.
   * Read from WMI, with `tasklist` as a fallback (then without ppid, path, commandLine and startTime).
   * @param {string|RegExp|function} [filter] text contained in the name, a RegExp tested against it, or a predicate
   * @param {boolean|{verbose?: boolean, source?: 'wmi'|'tasklist'}} [options] `verbose` adds
   *   sessionName, status, user, cpuTime and windowTitle from `tasklist /V` (slow)
   */
  async list(filter, options) {
    if (typeof options === 'boolean') { options = { verbose: options } }
    options = options || {};
    if (options.source && !['wmi', 'tasklist'].includes(options.source)) {
      throw new Error(`Invalid source "${options.source}", expected one of: wmi, tasklist`);
    }

    let tasks;
    if (options.source !== 'tasklist') {
      try {
        tasks = await query();
      } catch (error) {
        if (options.source === 'wmi') { throw error }
      }
    }
    if (!tasks) {
      tasks = await tasklist(options.verbose);
    } else if (options.verbose) {
      const details = new Map((await tasklist(true)).map(task => [task.pid, task]));
      for (const task of tasks) {
        const { sessionName = '', status = '', user = '', cpuTime = '', windowTitle = '' } = details.get(task.pid) || {};
        Object.assign(task, { sessionName, status, user, cpuTime, windowTitle });
      }
    }

    if (!filter) { return tasks }
    if (typeof filter === 'function') { return tasks.filter(filter) }
    if (filter instanceof RegExp) { return tasks.filter(task => filter.test(task.name)) }
    const text = String(filter).toLowerCase();
    return tasks.filter(task => String(task.name).toLowerCase().includes(text));
  },
};
