[![npm version](https://badge.fury.io/js/win-sv.svg)](https://badge.fury.io/js/win-sv)
[![CI](https://github.com/vision10/node-win-sv/actions/workflows/ci.yml/badge.svg)](https://github.com/vision10/node-win-sv/actions/workflows/ci.yml)

# win-sv

Run a Node.js script (or any executable) as a native Windows service.

- **Service**: install, start, stop, restart, refresh and uninstall services, hosted by [WinSW](https://github.com/winsw/winsw) v3.
- **No watchdog process**: crashes are handled by the Windows service manager itself (the "Recovery" tab of a service), configured with `onfailure`.
- **Logs**: read or follow the output of the service.
- **Any service**: list, query, start and stop the services of the machine by name.
- **Processes** and **event log** helpers.
- **Zero dependencies**, a CLI, CommonJS and ES module entry points, TypeScript types.

Requires Windows, Node.js 18.3 or newer and .NET Framework 4.6.1 or newer (part of Windows 10, 11 and Server 2016+).

## Installation

    npm install win-sv

## Usage

```js
const { Service } = require('win-sv');   // or: import { Service } from 'win-sv';

const svc = new Service({
  id: 'HelloWorld',                       // service name
  script: 'C:\\path\\to\\helloworld.js',
  // optional
  name: 'Hello World',                    // display name
  description: 'Server powered by Node.js.',
  onfailure: [{ action: 'restart', delay: 10 }],
});

await svc.install({ start: true });
```

### Administrator rights

Installing, starting, stopping and removing a service need administrator rights. From a normal terminal each of
those calls shows one UAC prompt. `install({ start: true })` and `uninstall()` of a running service do their two
steps behind a single prompt. Run from an elevated terminal to see none, or pass `noElevate` to fail instead of
prompting.

Whether elevation is needed is decided from exit codes and from the rights of the process, never from the text of
an error message, so it works whatever the display language of Windows.

### How it works

`install()` creates a folder (by default `daemon`, next to the script) containing:

- `<id>.exe`: a copy of WinSW, the process Windows actually runs as the service
- `<id>.xml`: its configuration, generated from the options below
- `<id>.out.log`, `<id>.err.log`: the output of your script, and `<id>.wrapper.log`

Keep that folder for as long as the service is installed. `uninstall(true)` removes it.

### Stopping gracefully

When the service is stopped, your script receives Ctrl+C, which Node.js reports as `SIGINT`. It then has
`stoptimeout` (15 seconds by default) to finish before it is killed.

```js
process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
```

### Options

Only `id` (or `name`) and `script` (or `execPath`) are required.

```js
{
  id: 'HelloWorld',            // service name, defaults to `name`
  name: 'Hello World',         // display name
  description: '',

  script: 'C:/app/server.js',
  scriptOptions: ['--port=9000'],        // arguments for the script
  execPath: 'C:/tools/node.exe',         // defaults to the node.exe running the install
  execOptions: ['--max-old-space-size=4096'], // arguments for the executable, alias: nodeOptions
  cwd: 'C:/app',                         // working directory, defaults to the script directory
  env: { HOME: process.env.USERPROFILE }, // or [{ name: 'HOME', value: '...' }]
  depend: ['Eventlog'],                  // services that must be running first

  winswDest: 'C:/different/path',        // where the wrapper folder goes, defaults to the script directory
  winswDir: 'service',                   // name of the wrapper folder, default: 'daemon'
  winswExe: 'C:/tools/wrapper.exe',      // another wrapper executable, see "Using another wrapper"

  // what Windows does when the script exits with an error, at most 3, the last one repeats
  onfailure: [
    { action: 'restart', delay: 10 },    // delay in seconds, or '10 sec', '5 min', '1 hour'
    { action: 'restart', delay: 60 },
    { action: 'none' },                  // 'restart' | 'reboot' | 'none'
  ],
  resetfailure: 3600,                    // seconds without failure before the count resets, default 1 day

  logpath: 'C:/logs',                    // default: the wrapper folder
  log: {
    mode: 'roll-by-size',                // 'append' (default) | 'reset' | 'none' | 'roll-by-size' | 'roll-by-time' | 'roll-by-size-time'
    sizeThreshold: 10240,                // KB, roll-by-size and roll-by-size-time
    keepFiles: 8,                        // roll-by-size
    pattern: 'yyyyMMdd',                 // roll-by-time and roll-by-size-time
    autoRollAtTime: '00:00:00',          // roll-by-size-time
  },

  startmode: 'automatic',                // 'automatic' (default) | 'manual' | 'disabled'
  delayedAutoStart: false,
  priority: 'normal',                    // 'idle' | 'belownormal' | 'normal' | 'abovenormal' | 'high' | 'realtime'
  stoptimeout: 15,                       // seconds given to the script to exit before it is killed

  logOnAs: 'LocalService',               // account running the service, see "Service account"

  // less common
  securityDescriptor: '',                // SDDL
  stoparguments: ['stop'],               // run the executable with these arguments to stop gracefully
  stopexecutable: 'C:/app/stop.cmd',
  startarguments: [],
  prestart: { executable: '', arguments: [], stdoutPath: '', stderrPath: '' }, // also poststart, prestop, poststop
  preshutdown: false,
  preshutdownTimeout: 180,
  autoRefresh: true,
  interactive: false,
  beeponshutdown: false,
  download: { from: '', to: '', failOnError: false, auth: 'basic', user: '', password: '', proxy: '' }, // or a list
}
```

Arguments given as an array are quoted for you; a string is used as written.
WinSW expands `%NAME%` environment variables found in any value.

See the [WinSW configuration reference](https://github.com/winsw/winsw/blob/v3/docs/xml-config-file.md) for details on each setting.

### Service account

A service runs as LocalSystem unless `logOnAs` says otherwise.

```js
logOnAs: 'LocalService'                  // or 'NetworkService': built-in accounts, no password
logOnAs: { domain: 'corp', account: 'gmsa$' }  // group managed service account, no password

// a user account: by default its password is asked for, in a Windows dialog, when the service is installed
logOnAs: { domain: 'corp', account: 'bob' }
logOnAs: { account: 'corp\\bob', prompt: 'console' }   // ask in the console instead
logOnAs: { prompt: 'dialog' }                          // ask for the user name too

// or give the password from your program, nothing is asked
logOnAs: { account: 'corp\\bob', password: process.env.SVC_PASSWORD, allowservicelogon: true }
```

- `allowservicelogon` grants the account the "Log on as a service" right.
- `svc.install({ user, password })` sets the account for that installation only and replaces `logOnAs`.
- A password is **never written to the configuration file**. It is passed to the wrapper on its command line while
  the service is being installed, where other processes of the machine can read it for that moment. Where that
  matters, prefer the prompt, or an account that needs no password (built-in or group managed).
- Do not keep the password in your source: read it from the environment or a secret store.

### Methods

Every method returns a Promise unless noted.

```js
await svc.install({ start, overwrite, noElevate, user, password });
await svc.uninstall({ removeFiles, force, noElevate, noWait }); // stops the service first if needed
await svc.start([noElevate][, noWait]);
await svc.stop([force][, noElevate][, noWait]);
await svc.restart([noElevate][, force]);
await svc.refresh([options][, noElevate]);  // apply changed options without reinstalling
await svc.status();       // 'NonExistent' | 'Inactive (stopped)' | 'Active (running)' | 'Active (starting)' | ...
await svc.isInstalled();  // boolean
await svc.isRunning();    // boolean
await svc.selfRestart();  // restart, callable from inside the service itself
await svc.customize(output, manufacturer);   // write a copy of the wrapper with another manufacturer name (12 to 15 characters)

await svc.logs();                            // last 100 lines of the script output
await svc.logs({ type: 'err', lines: 20 });  // type: 'out' | 'err' | 'wrapper'
svc.logFile('out');                          // path of the current log file, or undefined (not a Promise)
const watcher = svc.watchLogs('out', text => process.stdout.write(text)); // follow, then watcher.close()
```

- `install` always rewrites the configuration file; `overwrite` also replaces an existing wrapper executable.
- `uninstall` removes the Windows service. `removeFiles` also deletes the wrapper, its configuration and logs, never your application.
- `uninstall(removeFiles, forceStop, noElevate, noWait)` is still accepted.
- Failures reject with an `Error` carrying WinSW's message; `code` is its exit code, usually a [Windows error code](https://learn.microsoft.com/windows/win32/debug/system-error-codes) (`5` access denied, `1060` service does not exist, `1073` service already exists, `1223` UAC prompt declined...).

### Events

```js
svc.on('install', output => {});
svc.on('start', output => {});
svc.on('stop', output => {});
svc.on('restart', output => {});   // also emitted by selfRestart
svc.on('refresh', output => {});
svc.on('status', status => {});
svc.on('uninstall', output => {});
svc.on('customize', output => {});
svc.on('invalidinstallation', error => {}); // the wrapper files are missing
```

## CLI

```console
win-sv install --script C:\app\server.js --id MyApp --restart-delay 10 --start -- --port=9000
win-sv status --script C:\app\server.js --id MyApp
win-sv logs --script C:\app\server.js --id MyApp --follow
win-sv uninstall --script C:\app\server.js --id MyApp --remove-files
win-sv list spool
```

Commands: `install`, `uninstall`, `start`, `stop`, `restart`, `status`, `logs`, `list` and `xml` (print the generated configuration).
`--config service.json` loads any option listed above from a JSON or JS file. Run `win-sv --help` for everything.

Use the same `--script`, `--id` (and `--dest` if used) for every command, they locate the wrapper folder.

`--user LocalService` or `--user DOMAIN\name` sets the account. A user account asks for its password when
installing, unless `--password` or, better, the `WIN_SV_PASSWORD` environment variable provides it.

## Services

Any service of the machine, by its name (not its display name).

```js
const { services } = require('win-sv');

await services.get('Spooler');
// { name: 'Spooler', displayName: 'Print Spooler', description: '...', state: 'running', startMode: 'automatic',
//   pid: 4312, account: 'LocalSystem', path: 'C:\\WINDOWS\\System32\\spoolsv.exe', exitCode: 0 }
await services.get('nope');           // undefined

await services.list();                // every service, sorted by name
await services.list('print');         // text in the name or display name, a RegExp, or a function

await services.start('Spooler');      // waits; does nothing when already running
await services.stop('Spooler');       // also stops the services depending on it; does nothing when already stopped
await services.restart('Spooler');    // one UAC prompt for both steps
```

`state` is one of `running`, `stopped`, `start-pending`, `stop-pending`, `paused`, `pause-pending`, `continue-pending`.
`start`, `stop` and `restart` reject with code `1060` when the service does not exist, and ask for elevation when
the current process may not control the service.

## Processes

```js
const win = require('win-sv');

await win.process.list();                 // every process
await win.process.list('node');           // text in the name, a RegExp, or a function
await win.process.list('node', true);     // verbose: adds sessionName, status, user, cpuTime, windowTitle (slow)
// [{ name: 'node.exe', pid: 57516, ppid: 4120, sessionId: 1, memory: 41736000,
//    path: 'C:\\Program Files\\nodejs\\node.exe', commandLine: '...', startTime: '2026-01-31T10:20:30.0000000Z' }]

await win.process.kill(pidOrName[, force]);       // taskkill
await win.process.kill(pidOrName, filter, force); // with a taskkill filter, e.g. 'STATUS eq NOT RESPONDING'
```

- `memory` is in bytes. The list is read from WMI; if that fails `tasklist` is used instead and `ppid`, `path`,
  `commandLine` and `startTime` are missing. `{ source: 'tasklist' }` or `{ source: 'wmi' }` forces one.
- Killing by name can end several processes.
- A forced kill of a process the current user has no rights on is retried elevated (UAC prompt).
- `process.start`, `stop` and `restart` are the same functions as in `services`.

## Event logging

```js
const { EventLogger } = require('win-sv');

const log = new EventLogger('My App');             // APPLICATION log
const sys = new EventLogger('My App System', true); // SYSTEM log
const same = new EventLogger({ source: 'My App System', isSystem: true });

await log.registerEventSource(); // once, needs elevation

await log.info('Info log.'[, code]);
await log.warn('Warn log!'[, code]);
await log.error('Something went wrong.'[, code]);
await log.success('It worked.'[, code]);
```

- Uses `eventcreate`. `code` is the event id, from 1 to 1000 (default 1000).
- A new source has to be registered by an administrator. Call `registerEventSource()` once (UAC prompt);
  afterwards writing to the APPLICATION log needs no elevation. Writing to the SYSTEM log always does.
- A source name belongs to one log: the same name cannot be used for both APPLICATION and SYSTEM.
- A service running as LocalSystem is already elevated and needs none of this.

## PowerShell

Service and process queries, and the UAC prompts shown by this package, go through PowerShell. Windows
PowerShell 5.1 is used where Windows ships it; otherwise PowerShell 7 (`pwsh`) is picked up from its default
location or from `PATH`. Set `WIN_SV_POWERSHELL` to the path of the executable to choose it yourself.
The WinSW commands themselves (`install`, `start`, `stop`...) do not need PowerShell.

## Using another wrapper

The executable copied for each service can be replaced, per service with the `winswExe` option or globally with
the `WIN_SV_EXE` environment variable. A replacement has to read the same configuration file and answer the same
commands; `tests/acceptance/wrapper.js` states that contract and checks it:

```console
set WIN_SV_EXE=C:\path\to\wrapper.exe
npm run test:acceptance
```

## Tests

```console
npm test                 # unit tests: nothing is installed, no administrator rights needed
npm run test:acceptance  # installs, crashes, restarts and removes real services (one UAC prompt)
```

The acceptance tests are in two files, run them separately with `npm run test:acceptance -- wrapper` or `-- library`:

- `tests/acceptance/wrapper.js`: what the wrapper executable must do, without going through this package
- `tests/acceptance/library.js`: this package end to end, which doubles as a complete usage example

## Upgrading from 0.x

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE). Bundles [WinSW](https://github.com/winsw/winsw) v3.0.0-alpha.11 (.NET Framework build), also MIT, see `bin/WinSW.LICENSE.txt`.
