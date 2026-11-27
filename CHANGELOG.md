# Changelog

## 1.0.0

### Changed

- Bundles WinSW v3.0.0-alpha.11 (.NET Framework build, 0.7 MB) instead of v2.11.0 (17 MB).
  Services installed with 0.x keep running with their old wrapper; uninstall them with the old version before reinstalling.
- No dependencies: `xml` and `yargs` are replaced by a small XML writer and Node's `util.parseArgs`.
- `elevate.exe` is gone. WinSW asks for elevation itself, the other helpers use PowerShell `Start-Process -Verb RunAs`
  and now return the output of the elevated command.
- Elevation is decided from exit codes and from the rights of the process instead of the English text of error
  messages, so it also works on a Windows displayed in another language.
- Commands run without a shell (`execFile`), so names and arguments with spaces or quotes are safe.
- Requires Node.js 18.3 or newer.
- The wrapper folder (`daemon`) is created next to the script. 0.x resolved it from the script path itself, which failed.
- `install()` always rewrites the configuration file; `overwrite` only controls the wrapper executable.
- `uninstall()` checks the status first, so it no longer fails on a stopped or missing service. It also accepts an options object.
- `refresh(options)` now writes the changed options before asking WinSW to apply them.
- `status()` resolves `NonExistent` when the service files are missing instead of rejecting.
- Invalid `priority`, `startmode`, `log.mode` and `onfailure.action` values throw instead of being written to the file.
- `process.list()` reads WMI and returns `{ name, pid, ppid, sessionId, memory, path, commandLine, startTime }` with numbers
  as numbers and the same keys in every display language. `tasklist` remains as a fallback. 0.x returned the
  `tasklist` columns as text (`ImageName`, `PID`, `MemUsage`...).
- `process.kill(pidOrName, force)` matches the documented signature. Only a forced kill is retried elevated.
- `process.start/stop/restart` check the service first: an unknown service rejects with code 1060 without a
  prompt, and a service already in the wanted state is left alone.
- `logOnAs` with a user account and no password asks for the password when installing (it used to install with
  an empty password). A password given in `logOnAs` is passed to WinSW at install time and no longer written to
  the configuration file.
- `EventLogger.registerEventSource()` really registers the source (it only queried the registry before).
- The CLI command is `win-sv` (was `service`, and did not work).

### Fixed

- Script and executable arguments are written as one correctly quoted `<arguments>` element. WinSW v3 only reads the first one.
- `logOnAs` uses the v3 `<username>` format; `logOnAs: true` and the `env` object form now work as documented.
- `onfailure` without a delay no longer writes `undefined sec`.
- Special characters in values are escaped in element text as well as attributes.
- `winswDir` is honoured (the code only read `winswDirname`).
- `customize()` passed a misspelled option. The manufacturer is required and must be 12 to 15 characters long, as WinSW demands.
- `new Service()` accepted a configuration with only one of `id` and `script`.

### Added

- `isInstalled()`, `isRunning()`, `exePath`, `xmlPath`.
- `install({ start: true })`; it and `uninstall()` of a running service need a single UAC prompt.
- `logs()`, `logFile()`, `watchLogs()` and `logPath` to read the output of a service.
- `services`: `get`, `list`, `start`, `stop`, `restart` for any service of the machine.
- CLI commands `logs` and `list`, options `--user` and `--password` (or the `WIN_SV_PASSWORD` variable).
- ES module entry point: `import { Service } from 'win-sv'`.
- PowerShell 7 is used where Windows PowerShell 5.1 is missing; `WIN_SV_POWERSHELL` chooses the executable.
- `WIN_SV_EXE` replaces the bundled wrapper executable, like the `winswExe` option.
- Options: `winswExe`, `prestart`, `poststart`, `prestop`, `poststop`, `preshutdown`, `preshutdownTimeout`, `autoRefresh`,
  log modes `reset` and `none`, several `download` entries, `logOnAs` as a string or with `prompt`.
- `EventLogger.success()`, `EventLogger.isRegistered()`.
- `cmd.isElevated()`, `cmd.elevateAll()`, `cmd.admin()`, `cmd.powershell()`, `cmd.sys()`, `generateXml()` export.
- TypeScript declarations.
- Unit tests (`npm test`) and acceptance tests on real services (`npm run test:acceptance`), replacing the
  `examples` folder. `tests/acceptance/wrapper.js` states what a wrapper executable must do.
- `LICENSE`, `.gitattributes` and a GitHub Actions workflow.

### Removed

- `lib/wrapper.js`, the unused restart loop inherited from node-windows. Restarts are done by Windows through `onfailure`.
- `EventLogger.auditSuccess()` and `auditFailure()`: `eventcreate` cannot write audit events.
- `cmd.runAsAdmin()`, which referenced an undefined class.
