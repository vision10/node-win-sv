[![npm version](https://badge.fury.io/js/win-sv.svg)](https://badge.fury.io/js/win-sv)

# win-sv

Run a Node.js script (or any executable) as a native Windows service.

- **Service**: install, start, stop, restart, refresh and uninstall services, hosted by [WinSW](https://github.com/winsw/winsw) v3.
- **No watchdog process**: crashes are handled by the Windows service manager itself (the "Recovery" tab of a service), configured with `onfailure`.
- **Event logging**: write to the Windows event log.
- **Process helpers**: start/stop services by name, list and kill processes.
- **Zero dependencies**, a CLI, and TypeScript types.

Requires Windows, Node.js 18.3 or newer and .NET Framework 4.6.1 or newer (part of Windows 10, 11 and Server 2016+).

## Installation

    npm install win-sv

## Usage

```js
const { Service } = require('win-sv');

const svc = new Service({
  id: 'HelloWorld',                       // service name
  script: 'C:\\path\\to\\helloworld.js',
  // optional
  name: 'Hello World',                    // display name
  description: 'Server powered by Node.js.',
  onfailure: [{ action: 'restart', delay: 10 }],
});

await svc.install();
await svc.start();
```

Installing, starting, stopping and removing a service need administrator rights. From a normal
terminal each of those calls shows a UAC prompt; run your script from an elevated terminal to avoid them,
or pass `noElevate` to fail instead of prompting.

### How it works

`install()` creates a folder (by default `daemon`, next to the script) containing:

- `<id>.exe`: a copy of WinSW, the process Windows actually runs as the service
- `<id>.xml`: its configuration, generated from the options below
- `<id>.out.log`, `<id>.err.log`: the output of your script, and `<id>.wrapper.log`

Keep that folder for as long as the service is installed. `uninstall(true)` removes it.

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
  winswExe: 'C:/tools/WinSW-x64.exe',    // use another WinSW v3 build than the bundled one

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

  // account running the service, default LocalSystem
  logOnAs: 'LocalService',               // or 'NetworkService'
  logOnAs: { domain: 'mydomain', account: 'username', password: 'password', allowservicelogon: true },
  logOnAs: { domain: 'mydomain', account: 'gmsa$' }, // group managed service account, no password

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

### Methods

Every method returns a Promise.

```js
await svc.install({ overwrite, noElevate, user, password });
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
```

- `install` always rewrites the configuration file; `overwrite` also replaces an existing wrapper executable.
- `uninstall` removes the Windows service. `removeFiles` also deletes the wrapper, its configuration and logs, never your application.
- `uninstall(removeFiles, forceStop, noElevate, noWait)` is still accepted.
- Failures reject with an `Error` carrying WinSW's message; `code` is its exit code, usually a [Windows error code](https://learn.microsoft.com/windows/win32/debug/system-error-codes) (`5` access denied, `1060` service does not exist...).

### Events

```js
svc.on('install', output => svc.start());
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
win-sv uninstall --script C:\app\server.js --id MyApp --remove-files
```

Commands: `install`, `uninstall`, `start`, `stop`, `restart`, `status` and `xml` (print the generated configuration).
`--config service.json` loads any option listed above from a JSON or JS file. Run `win-sv --help` for everything.

Use the same `--script`, `--id` (and `--dest` if used) for every command, they locate the wrapper folder.

## Event logging

```js
const { EventLogger } = require('win-sv');

const log = new EventLogger('My App');             // APPLICATION log
const sys = new EventLogger('My App', true);       // SYSTEM log
const same = new EventLogger({ source: 'My App', isSystem: true });

await log.registerEventSource(); // once, needs elevation

await log.info('Info log.'[, code]);
await log.warn('Warn log!'[, code]);
await log.error('Something went wrong.'[, code]);
await log.success('It worked.'[, code]);
```

- Uses `eventcreate`. `code` is the event id, from 1 to 1000 (default 1000).
- A new source has to be registered by an administrator. Call `registerEventSource()` once (UAC prompt);
  afterwards writing to the APPLICATION log needs no elevation. Writing to the SYSTEM log always does.
- A service running as LocalSystem is already elevated and needs none of this.

## Process

```js
const win = require('win-sv');

await win.process.start(serviceName);   // net start
await win.process.stop(serviceName);    // net stop
await win.process.restart(serviceName);

await win.process.list([filter][, verbose]); // tasklist
await win.process.kill(pidOrName[, force]);  // taskkill
await win.process.kill(pidOrName, filter, force); // with a taskkill filter, e.g. 'STATUS eq NOT RESPONDING'
```

`list` resolves with one object per process. `filter` is text contained in the image name, a RegExp or a function.
`verbose` adds `Status`, `UserName`, `CPUTime` and `WindowTitle` (slower). Column names follow the Windows display language.

```js
[{ ImageName: 'node.exe', PID: '57516', SessionName: 'Console', 'Session#': '1', MemUsage: '41,736 K' }]
```

> Killing by name can end several processes.

`start`, `stop` and `kill` retry elevated (UAC prompt) when access is denied.

## Tests

```console
npm test              # unit tests: nothing is installed, no administrator rights needed
npm run test:service  # end to end: installs, crashes, restarts and removes real services (one UAC prompt)
```

The end to end test in `tests/integration.js` doubles as a complete usage example.

## Upgrading from 0.x

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. Bundles [WinSW](https://github.com/winsw/winsw) v3.0.0-alpha.11 (.NET Framework build), also MIT, see `bin/WinSW.LICENSE.txt`.
