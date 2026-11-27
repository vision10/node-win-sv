# Changelog

## 1.0.0

### Changed

- Bundles WinSW v3.0.0-alpha.11 (.NET Framework build, 0.7 MB) instead of v2.11.0 (17 MB).
  Services installed with 0.x keep running with their old wrapper; uninstall them with the old version before reinstalling.
- No dependencies: `xml` and `yargs` are replaced by a small XML writer and Node's `util.parseArgs`.
- `elevate.exe` is gone. WinSW asks for elevation itself, the other helpers use PowerShell `Start-Process -Verb RunAs`.
- Commands run without a shell (`execFile`), so names and arguments with spaces or quotes are safe.
- Requires Node.js 18.3 or newer.
- The wrapper folder (`daemon`) is created next to the script. 0.x resolved it from the script path itself, which failed.
- `install()` always rewrites the configuration file; `overwrite` only controls the wrapper executable.
- `uninstall()` checks the status first, so it no longer fails on a stopped or missing service. It also accepts an options object.
- `refresh(options)` now writes the changed options before asking WinSW to apply them.
- `status()` resolves `NonExistent` when the service files are missing instead of rejecting.
- Invalid `priority`, `startmode`, `log.mode` and `onfailure.action` values throw instead of being written to the file.
- `process.list(filter)` filters on the image name in JavaScript; `process.kill(pidOrName, force)` matches the documented signature.
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
- Options: `winswExe`, `prestart`, `poststart`, `prestop`, `poststop`, `preshutdown`, `preshutdownTimeout`, `autoRefresh`,
  log modes `reset` and `none`, several `download` entries, `logOnAs` as a string or with `prompt`.
- `EventLogger.success()`, `EventLogger.isRegistered()`.
- `cmd.isElevated()`, `generateXml()` export.
- TypeScript declarations.
- Unit tests (`npm test`) and an end to end test (`npm run test:service`), replacing the `examples` folder.

### Removed

- `lib/wrapper.js`, the unused restart loop inherited from node-windows. Restarts are done by Windows through `onfailure`.
- `EventLogger.auditSuccess()` and `auditFailure()`: `eventcreate` cannot write audit events.
- `cmd.runAsAdmin()`, which referenced an undefined class.
