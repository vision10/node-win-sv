'use strict';

const path = require('path');
const { existsSync } = require('fs');
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
   * Customizes the wrapper executable.
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
    const exe = existsSync(this.exePath) ? this.exePath : (this.config.winswExe || winsw.WINSW_EXE);
    const res = await cmd.run(exe, ['customize'].concat(args));
    this.emit('customize', res);
    return res;
  }

  /**
   * @param options.overwrite replace the wrapper executable if it already exists
   * @param options.noElevate Doesn't automatically trigger a UAC prompt.
   * @param options.user|username service account user name
   * @param options.pass|password service account password
   */
  async install(options) {
    options = options || {};
    winsw.createFiles(this.winswPath, this.config, { overwriteExe: options.overwrite === true });

    const args = flags({ noElevate: options.noElevate });
    const user = options.user || options.username;
    if (user) { args.push('--username', user, '--password', options.pass || options.password || '') }
    return this.exec('install', args);
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
    let res = '';
    if (this.exists) {
      const status = await this.exec('status', [], true);
      if (/^Active/.test(status)) { await this.stop(forceStop, noElevate, noWait) }
      if (status !== 'NonExistent') { res = await this.exec('uninstall', flags({ noElevate }), true) }
      if (removeFiles) { winsw.removeFiles(this.winswPath, this.id) }
    }
    this.emit('uninstall', res);
    return res;
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
   * Runs a WinSW command for this service. WinSW asks for elevation (UAC) by itself when needed.
   * @param {string} command
   * @param {string[]} [args]
   * @param {boolean} [silent] do not emit the command event
   */
  async exec(command, args, silent) {
    this.assertInstallation();

    let res;
    try {
      res = await cmd.run(this.exePath, [command].concat(args || []), { cwd: this.winswPath });
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
