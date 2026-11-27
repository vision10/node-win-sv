'use strict';

const fs = require('fs');
const path = require('path');
const { toXml } = require('./xml');

const WINSW_EXE = path.join(__dirname, '..', 'bin', 'WinSW.exe');

/**
 * The wrapper executable copied for each service: the `winswExe` option, else the WIN_SV_EXE
 * environment variable, else the bundled WinSW. Any executable honouring the same commands and
 * configuration file can take its place.
 */
function wrapperExe(config) {
  const custom = (config && config.winswExe) || process.env.WIN_SV_EXE;
  return custom ? path.resolve(custom) : WINSW_EXE;
}

const PRIORITIES = ['idle', 'belownormal', 'normal', 'abovenormal', 'high', 'realtime'];
const START_MODES = ['automatic', 'manual', 'boot', 'system', 'disabled'];
const LOG_MODES = ['append', 'reset', 'none', 'roll-by-size', 'roll-by-time', 'roll-by-size-time'];
const FAILURE_ACTIONS = ['restart', 'reboot', 'none'];
const HOOKS = ['prestart', 'poststart', 'prestop', 'poststop'];

/** Service id: `id`, falling back to `name`. */
function serviceId(config) {
  return String((config && (config.id || config.name)) || '').trim();
}

/** Absolute path of the script, or undefined when only an executable is hosted. */
function scriptPath(config) {
  return config.script ? path.resolve(String(config.script).trim()) : undefined;
}

/** Quotes one argument the way the Windows C runtime (and Node.js) parses a command line. */
function quoteArg(arg) {
  arg = String(arg);
  if (arg !== '' && !/[\s"]/.test(arg)) { return arg }
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/** An array is taken as a list of arguments (quoted when needed), a string is passed through untouched. */
function commandLine(args) {
  if (args === undefined || args === null) { return '' }
  if (Array.isArray(args)) { return args.map(quoteArg).join(' ') }
  return String(args).trim();
}

/** Numbers are seconds, strings are passed as is (`10 sec`, `5 min`, `1 hour`, `1 day`). */
function duration(value) {
  return typeof value === 'number' ? `${value} sec` : String(value).trim();
}

function list(value) {
  if (value === undefined || value === null || value === '') { return [] }
  return (Array.isArray(value) ? value : String(value).split(',')).map(v => String(v).trim()).filter(Boolean);
}

function oneOf(option, value, allowed) {
  const found = allowed.find(item => item === String(value).trim().toLowerCase());
  if (!found) { throw new Error(`Invalid \`${option}\` "${value}", expected one of: ${allowed.join(', ')}`) }
  return found;
}

const BUILT_IN = /^((NT AUTHORITY\\)?(LocalSystem|LocalService|NetworkService|System))$/i;

/** Normalises `logOnAs`: undefined when the default LocalSystem account is kept. */
function account(config) {
  let logOnAs = config && config.logOnAs;
  if (!logOnAs || logOnAs === true) { return undefined }
  if (typeof logOnAs === 'string') { logOnAs = { account: logOnAs } }

  let user = logOnAs.account || logOnAs.user || logOnAs.username;
  if (user) {
    user = String(user).trim();
    // the wrapper only recognises the built-in accounts under these exact names
    const builtIn = ['LocalSystem', 'NT AUTHORITY\\LocalService', 'NT AUTHORITY\\NetworkService']
      .find(name => [name, name.replace('NT AUTHORITY\\', '')].some(alias => alias.toLowerCase() === user.toLowerCase()));
    if (builtIn && !logOnAs.domain) { user = builtIn }
    else if (logOnAs.domain && !/[\\@]/.test(user)) { user = logOnAs.domain + '\\' + user }
  }
  // built-in and group managed (name ending with $) accounts have no password
  const needsPassword = !user || !(BUILT_IN.test(user) || user.endsWith('$'));
  const hasPassword = needsPassword && logOnAs.password !== undefined && logOnAs.password !== null;
  return {
    user,
    password: hasPassword ? String(logOnAs.password) : undefined,
    // without a password WinSW asks for it when the service is installed
    prompt: needsPassword && !(user && hasPassword) ? oneOf('logOnAs.prompt', logOnAs.prompt || 'dialog', ['dialog', 'console']) : undefined,
    allowservicelogon: logOnAs.allowservicelogon,
  };
}

/**
 * Credentials handed to WinSW when the service is installed.
 * A password given in `logOnAs` is never written to the configuration file, it only travels on that command line.
 */
function installCredentials(config) {
  const acc = account(config);
  return acc && acc.user && acc.password !== undefined ? { user: acc.user, password: acc.password } : undefined;
}

function serviceAccount(config) {
  const acc = account(config);
  if (!acc) { return undefined }
  const children = [];
  if (acc.user) { children.push({ tag: 'username', text: acc.user }) }
  if (acc.prompt) { children.push({ tag: 'prompt', text: acc.prompt }) }
  if (acc.allowservicelogon !== undefined) {
    children.push({ tag: 'allowservicelogon', text: Boolean(acc.allowservicelogon) });
  }
  return { tag: 'serviceaccount', children };
}

function logNode(log) {
  if (typeof log === 'string') { log = { mode: log } }
  const mode = oneOf('log.mode', log.mode || 'append', LOG_MODES);
  const children = [];
  if (mode === 'roll-by-size' || mode === 'roll-by-size-time') {
    children.push({ tag: 'sizeThreshold', text: log.sizeThreshold || 10240 });
  }
  if (mode === 'roll-by-size') {
    children.push({ tag: 'keepFiles', text: log.keepFiles || 8 });
  }
  if (mode === 'roll-by-time' || mode === 'roll-by-size-time') {
    children.push({ tag: 'pattern', text: log.pattern || 'yyyyMMdd' });
  }
  if (mode === 'roll-by-size-time' && log.autoRollAtTime) {
    children.push({ tag: 'autoRollAtTime', text: log.autoRollAtTime });
  }
  for (const key of ['zipOlderThanNumDays', 'zipDateFormat']) {
    if (log[key]) { children.push({ tag: key, text: log[key] }) }
  }
  return { tag: 'log', attrs: { mode }, children };
}

function generateXml(config) {
  const id = serviceId(config);
  if (!id || !(config.script || config.execPath)) {
    throw new Error('WinSW requires at least an `id` and a `script` (or `execPath`) to run!');
  }
  const script = scriptPath(config);
  const nodes = [{ tag: 'id', text: id }];
  const add = (tag, text) => nodes.push({ tag, text });

  if (config.name) { add('name', config.name) }
  if (config.description) { add('description', config.description) }

  // a bare command (`python`, `java`) is left for the service to find on PATH
  const exec = config.execPath || process.execPath;
  add('executable', /[\\/]/.test(exec) ? path.resolve(exec) : exec);

  const args = [commandLine(config.execOptions || config.nodeOptions)];
  if (script) { args.push(quoteArg(script)) }
  args.push(commandLine(config.scriptOptions));
  const argLine = args.filter(Boolean).join(' ');

  // WinSW: when <stoparguments> is used, <startarguments> must be used instead of <arguments>
  const hasStop = config.stoparguments !== undefined && config.stoparguments !== null;
  const startLine = commandLine(config.startarguments) || argLine;
  if (startLine) { add(hasStop ? 'startarguments' : 'arguments', startLine) }
  if (hasStop) {
    if (typeof config.stopexecutable === 'string') { add('stopexecutable', config.stopexecutable) }
    add('stoparguments', commandLine(config.stoparguments));
  }

  const cwd = config.cwd || config.workingdirectory;
  if (cwd || script) { add('workingdirectory', path.resolve(cwd || path.dirname(script))) }

  if (config.env) {
    const env = Array.isArray(config.env)
      ? config.env
      : Object.entries(config.env).map(([name, value]) => ({ name, value }));
    for (const item of env) {
      if (!item || !item.name || item.value === undefined || item.value === null) { continue }
      nodes.push({ tag: 'env', attrs: { name: item.name, value: item.value } });
    }
  }

  list(config.depend).forEach(service => add('depend', service));

  if (config.logpath) { add('logpath', path.resolve(config.logpath)) }
  if (config.log) { nodes.push(logNode(config.log)) }

  if (config.priority) { add('priority', oneOf('priority', config.priority, PRIORITIES)) }
  if (config.startmode) { add('startmode', oneOf('startmode', config.startmode, START_MODES)) }
  if (config.delayedAutoStart) { add('delayedAutoStart', true) }
  if (config.stoptimeout) { add('stoptimeout', duration(config.stoptimeout)) }

  const logOn = serviceAccount(config);
  if (logOn) { nodes.push(logOn) }

  // Recovery is delegated to the Windows service control manager, no watchdog process is needed
  if (config.resetfailure) { add('resetfailure', duration(config.resetfailure)) }
  const failures = config.onfailure ? [].concat(config.onfailure) : [];
  if (failures.length > 3) { throw new Error('`onfailure` accepts at most 3 actions.') }
  for (const failure of failures) {
    const item = typeof failure === 'string' ? { action: failure } : failure;
    const attrs = { action: oneOf('onfailure.action', item.action, FAILURE_ACTIONS) };
    if (item.delay !== undefined && item.delay !== null) { attrs.delay = duration(item.delay) }
    nodes.push({ tag: 'onfailure', attrs });
  }

  const sddl = config.securityDescriptor || config.securitydescriptor;
  if (sddl) { add('securityDescriptor', sddl) }

  for (const hook of HOOKS) {
    const cfg = config[hook];
    if (!cfg) { continue }
    if (!cfg.executable) { throw new Error(`\`${hook}.executable\` is required.`) }
    const children = [{ tag: 'executable', text: cfg.executable }];
    if (cfg.arguments) { children.push({ tag: 'arguments', text: commandLine(cfg.arguments) }) }
    if (cfg.stdoutPath) { children.push({ tag: 'stdoutPath', text: cfg.stdoutPath }) }
    if (cfg.stderrPath) { children.push({ tag: 'stderrPath', text: cfg.stderrPath }) }
    nodes.push({ tag: hook, children });
  }

  if (config.preshutdown) { add('preshutdown', true) }
  if (config.preshutdownTimeout) { add('preshutdownTimeout', duration(config.preshutdownTimeout)) }
  if (config.autoRefresh === false) { add('autoRefresh', false) }
  if (config.interactive) { add('interactive', true) }
  if (config.beeponshutdown) { add('beeponshutdown', true) }

  for (const d of (config.download ? [].concat(config.download) : [])) {
    if (!d.from || !d.to) { throw new Error('`download` requires `from` and `to`.') }
    nodes.push({
      tag: 'download',
      attrs: {
        from: d.from,
        to: d.to,
        failOnError: d.failOnError ? true : undefined,
        proxy: d.proxy,
        auth: d.auth,
        unsecureAuth: d.unsecureAuth ? true : undefined,
        user: d.user || d.username,
        password: (d.user || d.username) ? (d.password || '') : undefined,
      },
    });
  }

  return toXml({ tag: 'service', children: nodes });
}

/**
 * Writes `<id>.xml` and a copy of WinSW named `<id>.exe` into `dir`.
 * Each service gets its own copy so a running service never locks the one inside node_modules.
 */
function createFiles(dir, config, options) {
  const overwriteExe = !options || options.overwriteExe !== false;
  const xml = generateXml(config);
  const source = wrapperExe(config);
  if (!fs.existsSync(source)) { throw new Error(`Wrapper executable not found: ${source}`) }

  dir = path.resolve(dir || process.cwd());
  fs.mkdirSync(dir, { recursive: true });

  const dest = path.join(dir, serviceId(config));
  writeXml(dest + '.xml', xml);
  if (!overwriteExe && fs.existsSync(dest + '.exe')) { return { exe: dest + '.exe', xml: dest + '.xml' } }
  try {
    fs.copyFileSync(source, dest + '.exe');
  } catch (error) {
    // the executable is locked while the service runs, the existing copy keeps working
    if (!(fs.existsSync(dest + '.exe') && ['EBUSY', 'EPERM'].includes(error.code))) { throw error }
  }
  return { exe: dest + '.exe', xml: dest + '.xml' };
}

function writeXml(file, xml) {
  fs.writeFileSync(file, '﻿' + xml, 'utf8');
}

/** Removes the files generated for a service (wrapper, configuration, logs) and the folder if left empty. */
function removeFiles(dir, id) {
  if (!fs.existsSync(dir)) { return }
  const prefix = id.toLowerCase() + '.';
  const generated = /^(xml|exe|exe\.config|(.+\.)?(out|err|wrapper)\.log(\.old)?)$/i;

  for (const file of fs.readdirSync(dir)) {
    if (!file.toLowerCase().startsWith(prefix) || !generated.test(file.slice(prefix.length))) { continue }
    fs.rmSync(path.join(dir, file), { force: true, maxRetries: 10, retryDelay: 200 });
  }
  if (!fs.readdirSync(dir).length) { fs.rmdirSync(dir) }
}

module.exports = {
  WINSW_EXE,
  wrapperExe,
  account,
  installCredentials,
  serviceId,
  scriptPath,
  quoteArg,
  generateXml,
  createFiles,
  writeXml,
  removeFiles,
};
