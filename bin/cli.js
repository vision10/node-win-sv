#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseArgs } = require('util');
const pkg = require('../package.json');

const COMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'logs', 'list', 'xml'];

const HELP = `${pkg.name} v${pkg.version}
${pkg.description}

Usage:
  win-sv <command> --script <path> [options] [-- script arguments]
  win-sv <command> --config <file.json|file.js> [options]
  win-sv list [filter] [--json]

Commands:
  install      Create the service files and register the service
  uninstall    Stop and remove the service
  start        Start the service
  stop         Stop the service
  restart      Stop and then start the service
  status       Print the service status
  logs         Print the end of the service output
  list         List the services installed on this machine, optionally filtered by name
  xml          Print the generated configuration, changes nothing

Options:
  -s, --script <path>        Script to run as a service
  -i, --id <id>              Service id, defaults to the script file name
  -n, --name <name>          Display name
      --description <text>   Description shown in the services manager
  -d, --cwd <path>           Working directory, defaults to the script directory
  -c, --config <file>        JSON or JS file with any option accepted by \`new Service()\`
      --exec <path>          Executable running the script, defaults to this node.exe
      --arg <value>          Argument passed to the script (repeatable), or put them all after --
      --env <NAME=value>     Environment variable (repeatable)
      --dest <path>          Where the wrapper folder is created, defaults to the script directory
      --logpath <path>       Folder for the log files
      --log <mode>           append | reset | none | roll-by-size | roll-by-time | roll-by-size-time
      --startmode <mode>     automatic | manual | disabled
      --restart-delay <sec>  Restart the service this many seconds after a failure
      --user <account>       Account running the service: LocalService, NetworkService or DOMAIN\\user.
                             A user account asks for its password when installing, unless --password
                             or the WIN_SV_PASSWORD environment variable provides it
      --password <password>
      --start                install: start the service once installed
      --overwrite            install: replace an existing wrapper executable
      --remove-files         uninstall: delete the wrapper, configuration and logs
      --force                stop/restart/uninstall: also stop dependent services
      --no-elevate           Fail instead of showing a UAC prompt
      --err                  logs: the error output instead of the standard output
      --wrapper              logs: the log of the wrapper itself
      --lines <count>        logs: number of lines, default 100
  -f, --follow               logs: keep printing what is appended
      --json                 list: print JSON
  -h, --help
  -v, --version
`;

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function buildConfig(values, scriptArgs) {
  let config = {};
  if (values.config) {
    const file = path.resolve(values.config);
    config = { ...require(file) };
    // relative paths in a config file are relative to that file
    const dir = path.dirname(file);
    for (const key of ['script', 'cwd', 'workingdirectory', 'winswDest', 'logpath']) {
      if (config[key]) { config[key] = path.resolve(dir, config[key]) }
    }
  }
  if (values.script) { config.script = path.resolve(values.script) }
  if (values.id) { config.id = values.id }
  if (values.name) { config.name = values.name }
  if (values.description) { config.description = values.description }
  if (values.cwd) { config.cwd = path.resolve(values.cwd) }
  if (values.exec) { config.execPath = values.exec }
  const args = (values.arg || []).concat(scriptArgs || []);
  if (args.length) { config.scriptOptions = args }
  if (values.dest) { config.winswDest = path.resolve(values.dest) }
  if (values.logpath) { config.logpath = path.resolve(values.logpath) }
  if (values.log) { config.log = { ...config.log, mode: values.log } }
  if (values.startmode) { config.startmode = values.startmode }
  if (values.user) {
    const password = values.password !== undefined ? values.password : process.env.WIN_SV_PASSWORD;
    config.logOnAs = { ...(typeof config.logOnAs === 'object' ? config.logOnAs : {}), account: values.user };
    if (password !== undefined) { config.logOnAs.password = password }
  } else if (values.password !== undefined) {
    throw new Error('--password requires --user');
  }
  if (values['restart-delay'] !== undefined) {
    config.onfailure = [{ action: 'restart', delay: Number(values['restart-delay']) || 0 }];
  }
  if (values.env) {
    const env = Array.isArray(config.env) ? [...config.env] : Object.entries(config.env || {}).map(([name, value]) => ({ name, value }));
    for (const pair of values.env) {
      const at = pair.indexOf('=');
      if (at < 1) { throw new Error(`Invalid --env "${pair}", expected NAME=value`) }
      env.push({ name: pair.slice(0, at), value: pair.slice(at + 1) });
    }
    config.env = env;
  }
  if (!config.id && !config.name && config.script) {
    config.id = path.basename(config.script, path.extname(config.script));
  }
  return config;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      script: { type: 'string', short: 's' },
      id: { type: 'string', short: 'i' },
      name: { type: 'string', short: 'n' },
      description: { type: 'string' },
      cwd: { type: 'string', short: 'd' },
      config: { type: 'string', short: 'c' },
      exec: { type: 'string' },
      arg: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true },
      dest: { type: 'string' },
      logpath: { type: 'string' },
      log: { type: 'string' },
      startmode: { type: 'string' },
      'restart-delay': { type: 'string' },
      user: { type: 'string' },
      password: { type: 'string' },
      err: { type: 'boolean' },
      wrapper: { type: 'boolean' },
      lines: { type: 'string' },
      follow: { type: 'boolean', short: 'f' },
      json: { type: 'boolean' },
      start: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'remove-files': { type: 'boolean' },
      force: { type: 'boolean' },
      'no-elevate': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) { return console.log(pkg.version) }
  const command = positionals[0];
  if (values.help || !command) { return console.log(HELP) }
  if (!COMMANDS.includes(command)) { throw new Error(`Unknown command "${command}".\n\n${HELP}`) }

  const { Service, services, generateXml } = require('../index');
  if (command === 'list') {
    const found = await services.list(positionals[1]);
    if (values.json) { return console.log(JSON.stringify(found, null, 2)) }
    const width = key => Math.max(key.length, ...found.map(service => String(service[key]).length));
    const columns = ['name', 'state', 'startMode', 'displayName'];
    const widths = columns.map(width);
    const line = cells => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd();
    console.log(line(columns.map(column => column.toUpperCase())));
    return found.forEach(service => console.log(line(columns.map(column => service[column]))));
  }

  const config = buildConfig(values, positionals.slice(1));
  if (command === 'xml') { return process.stdout.write(generateXml(config)) }

  const service = new Service(config);
  const noElevate = values['no-elevate'];
  let output;
  switch (command) {
    case 'install':
      output = await service.install({ overwrite: values.overwrite, start: values.start, noElevate });
      break;
    case 'uninstall':
      output = await service.uninstall({ removeFiles: values['remove-files'], force: values.force, noElevate });
      break;
    case 'start': output = await service.start(noElevate); break;
    case 'stop': output = await service.stop(values.force, noElevate); break;
    case 'restart': output = await service.restart(noElevate, values.force); break;
    case 'status': output = await service.status(); break;
    case 'logs': {
      const type = values.wrapper ? 'wrapper' : (values.err ? 'err' : 'out');
      output = await service.logs({ type, lines: Number(values.lines) || 100 });
      if (values.follow) {
        if (output) { console.log(output) }
        service.watchLogs({ type }, text => process.stdout.write(text));
        return;
      }
      break;
    }
  }
  if (output) { console.log(output) }
}

main().catch(error => fail(error.message));
