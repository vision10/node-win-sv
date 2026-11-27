'use strict';

const path = require('path');
const fs = require('fs');
const { existsSync } = fs;
const { EventEmitter } = require('events');

const cmd = require('./cmd');
const winsw = require('./winsw');

const ERROR_SERVICE_DOES_NOT_EXIST = 1060;

module.exports = class Service extends EventEmitter {
  /**
   * @param {object} config see README for all options, `id` (or `name`) and `script` (or `execPath`) are required
   */
  constructor(config) {
    super();
    config = config || {};
    if (!winsw.serviceId(config) || !(config.script || config.execPath)) {
      throw new Error('`id` and `script` properties are required but were not provided!');
    }
    this.config = { ...config };
  }

  get id() { return winsw.serviceId(this.config) }
  get name() { return this.config.name || this.id }

  /** Folder holding the WinSW wrapper (`<id>.exe`), its configuration (`<id>.xml`) and by default the logs. */
  get winswPath() {
    const script = winsw.scriptPath(this.config);
    const base = this.config.winswDest || (script ? path.dirname(script) : process.cwd());
    return path.resolve(base, this.config.winswDir || this.config.winswDirname || 'daemon');
  }
  get exePath() { return path.join(this.winswPath, this.id + '.exe') }
  get xmlPath() { return path.join(this.winswPath, this.id + '.xml') }
  /** true when the wrapper files are on disk (says nothing about the service being registered, see `status`) */
  get exists() { return existsSync(this.exePath) && existsSync(this.xmlPath) }

  /**
   * @returns {Promise<string>} `NonExistent`, `Inactive (stopped)`, `Active (running)`, `Active (starting)`, `Active (stopping)`...
   */
  async status() {
    if (!this.exists) {
      this.emit('status', 'NonExistent');
      return 'NonExistent';
    }
    return this.exec('status');
  }
  async isInstalled() { return (await this.status()) !== 'NonExistent' }
  async isRunning() { return /^Active/.test(await this.status()) }

  /**
   * @param noElevate Doesn't automatically trigger a UAC prompt.
   * @param noWait Doesn't wait for the service to actually start.
   */
  start(noElevate, noWait) {
    return this.exec('start', flags({ noElevate, noWait }));
  }

  /**
   * @param force Stops the service even if it has started dependent services.
   * @param noElevate Doesn't automatically trigger a UAC prompt.
   * @param noWait Doesn't wait for the service to actually stop.
   */
  stop(force, noElevate, noWait) {
    return this.exec('stop', flags({ noElevate, noWait, force }));
  }

  /**
   * @param noElevate Doesn't automatically trigger a UAC prompt.
   * @param force Restarts the service even if it has started dependent services.
   */
  restart(noElevate, force) {
    return this.exec('restart', flags({ noElevate, force }));
  }

  /**
   * Restart meant to be called from the service itself (the wrapper outlives the process it restarts).
   */
  selfRestart() {
    return this.exec('restart!');
  }

  /**
   * Applies configuration changes to the installed service without reinstalling it.
   * @param options Options to change, merged into the current configuration
   * @param noElevate Doesn't automatically trigger a UAC prompt.
   */
  async refresh(options, noElevate) {
    const config = { ...this.config, ...options };
    if (winsw.serviceId(config) !== this.id) { throw new Error('The service id cannot be changed, reinstall the service instead.') }
    const xml = winsw.generateXml(config);
    this.assertInstallation();
    winsw.writeXml(this.xmlPath, xml);
    this.config = config;
    return this.exec('refresh', flags({ noElevate }));
  }

  /**
   * Customizes the wrapper executable. WinSW only: the bundled winsv answers with exit code 120.
   * @param output Required. Specifies the path to the output file.
   * @param manufacturer Required. Manufacturer name of the customized executable, WinSW accepts 12 to 15 characters.
   */
  async customize(output, manufacturer) {
    if (!output) { throw new Error('output is required!') }
    manufacturer = String(manufacturer || '');
    if (manufacturer.length < 12 || manufacturer.length > 15) {
      throw new Error('manufacturer is required and must be 12 to 15 characters long!');
    }
    const args = ['--output', path.resolve(output), '--manufacturer', manufacturer];
    const exe = existsSync(this.exePath) ? this.exePath : winsw.wrapperExe(this.config);
    const res = await cmd.run(exe, ['customize'].concat(args));
    this.emit('customize', res);
    return res;
  }

  /**
   * Registers the service. The service account comes from `logOnAs`, or from `user` and `password` given here.
   * @param options.start also start the service, behind the same UAC prompt
   * @param options.overwrite replace the wrapper executable if it already exists
   * @param options.noElevate Doesn't automatically trigger a UAC prompt.
   * @param options.user|username service account user name
   * @param options.pass|password service account password
   */
  async install(options) {
    options = options || {};
    // An account given here replaces the one of `logOnAs` for this installation. It has to be in the
    // configuration file as well: the wrapper prefers the user name written there.
    let config = this.config;
    const user = options.user || options.username;
    const password = [options.pass, options.password].find(value => value !== undefined && value !== null);
    if (user || password !== undefined) {
      const logOnAs = config.logOnAs;
      const base = logOnAs && typeof logOnAs === 'object' ? logOnAs : (typeof logOnAs === 'string' ? { account: logOnAs } : {});
      config = {
        ...config,
        // the password of `logOnAs` belongs to its account, not to another user named here
        logOnAs: user
          ? { account: user, password: password !== undefined ? password : '', allowservicelogon: base.allowservicelogon }
          : { ...base, password },
      };
    }
    winsw.createFiles(this.winswPath, config, { overwriteExe: options.overwrite === true });

    const args = flags({ noElevate: options.noElevate });
    const credentials = winsw.installCredentials(config);
    // asked of the copy this service runs: an existing one is kept unless `overwrite` is set
    if (!winsw.isWinSW(this.exePath)) {
      // winsv: one command installs and starts, and reads the password from its standard input,
      // also when it has to ask for administrator rights
      if (options.start) { args.push('--start') }
      if (credentials) { args.push('--username', credentials.user, '--password-stdin') }
      const res = await this.exec('install', args, false, credentials ? credentials.password + '\n' : undefined);
      if (options.start) { this.emit('start', res) }
      return res;
    }
    if (credentials) { args.push('--username', credentials.user, '--password', credentials.password) }
    const commands = [['install', args]];
    if (options.start) { commands.push(['start', flags({ noElevate: options.noElevate })]) }
    return (await this.execAll(commands, options.noElevate)).filter(Boolean).join('\n');
  }

  /**
   * Stops the service if needed, then removes it.
   * @param removeFiles remove the files generated for the service (wrapper, configuration, logs)
   * @param forceStop stop the service even if it has started dependent services
   * @param noElevate Doesn't automatically trigger a UAC prompt.
   * @param noWait Doesn't wait for the service to actually stop.
   */
  async uninstall(removeFiles, forceStop, noElevate, noWait) {
    if (removeFiles && typeof removeFiles === 'object') {
      const options = removeFiles;
      removeFiles = options.removeFiles;
      forceStop = options.forceStop || options.force;
      noElevate = options.noElevate;
      noWait = options.noWait;
    }
    const commands = [];
    if (this.exists) {
      const status = await this.exec('status', [], true);
      if (/^Active/.test(status)) { commands.push(['stop', flags({ noElevate, noWait, force: forceStop })]) }
      if (status !== 'NonExistent') { commands.push(['uninstall', flags({ noElevate })]) }
    }
    let res = '';
    if (commands.length) { res = (await this.execAll(commands, noElevate)).pop() }
    else { this.emit('uninstall', res) }
    if (removeFiles && existsSync(this.winswPath)) { winsw.removeFiles(this.winswPath, this.id) }
    return res;
  }

  /** Folder the log files are written to. */
  get logPath() { return this.config.logpath ? path.resolve(this.config.logpath) : this.winswPath }

  /**
   * Path of the current log file, undefined when there is none yet.
   * @param {'out'|'err'|'wrapper'} [type] output of the script (default), its errors, or the wrapper's own log
   */
  logFile(type) {
    type = type || 'out';
    if (!['out', 'err', 'wrapper'].includes(type)) { throw new Error('Invalid log type "' + type + '", expected one of: out, err, wrapper') }
    const dir = this.logPath;
    if (!existsSync(dir)) { return undefined }
    // rolling modes put a counter or a date between the id and the type:
    // `<id>.0.out.log`, `<id>.<date>.#0001.out.log`, and `<id>_<date>.out.log` when rolled by time
    const id = this.id.toLowerCase();
    const suffix = '.' + type + '.log';
    let latest;
    for (const name of fs.readdirSync(dir)) {
      const lower = name.toLowerCase();
      if (!lower.startsWith(id) || !lower.endsWith(suffix) || lower.length < id.length + suffix.length) { continue }
      const between = lower.slice(id.length, lower.length - suffix.length);
      // `_` followed by a digit is a date; anything else after `_` is the log of another service (`<id>_other`)
      if (between && !between.startsWith('.') && !/^_\d/.test(between)) { continue }
      const modified = fs.statSync(path.join(dir, name)).mtimeMs;
      if (!latest || modified > latest.modified) { latest = { file: path.join(dir, name), modified } }
    }
    return latest && latest.file;
  }

  /**
   * Last lines of a log file.
   * @param {{type?: 'out'|'err'|'wrapper', lines?: number}|string} [options] 100 lines of the script output by default
   * @returns {Promise<string>}
   */
  async logs(options) {
    if (typeof options === 'string') { options = { type: options } }
    options = options || {};
    const file = this.logFile(options.type);
    if (!file) { return '' }
    const lines = options.lines > 0 ? Math.trunc(options.lines) : 100;
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 4 * 1024 * 1024);
      const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
      const all = buffer.toString('utf8').replace(/\r?\n$/, '').split(/\r?\n/);
      return all.slice(-lines).join('\n');
    } finally {
      await handle.close();
    }
  }

  /**
   * Calls `listener(text)` with whatever is appended to a log file, until `close()` is called on the result.
   * @param {{type?: 'out'|'err'|'wrapper', interval?: number}|string} [options]
   * @param {(text: string) => void} listener
   */
  watchLogs(options, listener) {
    if (typeof options === 'function') { [options, listener] = [{}, options] }
    if (typeof options === 'string') { options = { type: options } }
    options = options || {};
    let file = this.logFile(options.type);
    let position = file ? fs.statSync(file).size : 0;
    const timer = setInterval(() => {
      try {
        const current = this.logFile(options.type);
        if (!current) { return }
        // a new file after a roll, or a truncated one, is read from its start
        if (current !== file) { [file, position] = [current, 0] }
        const size = fs.statSync(file).size;
        if (size < position) { position = 0 }
        if (size === position) { return }
        const buffer = Buffer.alloc(size - position);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, buffer, 0, buffer.length, position) } finally { fs.closeSync(fd) }
        position = size;
        listener(buffer.toString('utf8'));
      } catch (error) { /* the file is being rolled, try again on the next tick */ }
    }, options.interval || 500);
    return { close: () => clearInterval(timer) };
  }

  assertInstallation() {
    for (const [file, what] of [[this.exePath, 'executable'], [this.xmlPath, 'configuration file']]) {
      if (existsSync(file)) { continue }
      const err = new Error(`WinSW ${what} cannot be found in (${file}), is the service installed?`);
      this.emit('invalidinstallation', err);
      throw err;
    }
  }

  /**
   * Runs several WinSW commands in order, stopping at the first failure. From a process without
   * administrator rights they share a single UAC prompt instead of one each.
   * @param {Array<[string, string[]?]>} commands
   * @param {boolean} [noElevate] never prompt
   * @returns {Promise<string[]>} the output of each command
   */
  async execAll(commands, noElevate) {
    this.assertInstallation();
    if (commands.length < 2 || noElevate || await cmd.isElevated()) {
      const results = [];
      for (const [command, args] of commands) { results.push(await this.exec(command, args)) }
      return results;
    }
    const results = await cmd.elevateAll(commands.map(([command, args]) => [this.exePath, [command].concat(args || [])]), { cwd: this.winswPath });
    results.forEach((res, i) => this.emit(commands[i][0].replace('!', ''), res));
    return results;
  }

  /**
   * Runs a WinSW command for this service. WinSW asks for elevation (UAC) by itself when needed.
   * @param {string} command
   * @param {string[]} [args]
   * @param {boolean} [silent] do not emit the command event
   * @param {string} [input] written to the standard input of the command
   */
  async exec(command, args, silent, input) {
    this.assertInstallation();

    let res;
    try {
      res = await cmd.run(this.exePath, [command].concat(args || []), { cwd: this.winswPath, input });
    } catch (error) {
      // `status` reports the state through its exit code: 0 stopped, 1 active, 1060 not installed
      const isStatus = command === 'status' && (error.code === 1 || error.code === ERROR_SERVICE_DOES_NOT_EXIST);
      if (!isStatus || !error.stdout) { throw error }
      res = error.stdout;
    }
    if (!silent) { this.emit(command.replace('!', ''), res) }
    return res;
  }
}

function flags(options) {
  const args = [];
  if (options.noElevate) { args.push('--no-elevate') }
  if (options.noWait) { args.push('--no-wait') }
  if (options.force) { args.push('--force') }
  return args;
}
