'use strict';

const { execFile } = require('child_process');
const { quoteArg } = require('./winsw');

const ACCESS_DENIED = /access is denied|access denied|accessdenied|administrator|requires elevation|error 5\b/i;

/**
 * Runs an executable without a shell.
 * Resolves with the trimmed stdout, rejects with an Error carrying `code`, `stdout` and `stderr`.
 * @param {string} file
 * @param {string[]} [args]
 * @param {object} [options] child_process.execFile options
 * @returns {Promise<string>}
 */
function run(file, args, options) {
  return new Promise((resolve, reject) => {
    if (!file) { return reject(new Error('Command not provided!')) }
    const opts = { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options };

    execFile(file, [].concat(args || []).map(String), opts, (error, stdout, stderr) => {
      stdout = String(stdout || '').trim();
      stderr = String(stderr || '').trim();
      if (!error) { return resolve(stdout) }

      const err = new Error(stderr || stdout || error.message);
      err.code = error.code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

/** Resolves true when the current process has administrator rights. */
function isElevated() {
  // `net session` only succeeds for administrators
  return run('net', ['session']).then(() => true, () => false);
}

/**
 * Runs an executable as administrator (triggers a UAC prompt) and waits for it to finish.
 * The output of an elevated process cannot be captured, so this resolves with an empty string.
 */
function elevate(file, args, options) {
  if (!file) { return Promise.reject(new Error('Command not provided!')) }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$p = @{ FilePath = $env:WINSV_FILE; Verb = "RunAs"; WindowStyle = "Hidden"; Wait = $true; PassThru = $true }',
    'if ($env:WINSV_ARGS) { $p.ArgumentList = $env:WINSV_ARGS }',
    'if ($env:WINSV_CWD) { $p.WorkingDirectory = $env:WINSV_CWD }',
    'try { $proc = Start-Process @p } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }',
    'exit $proc.ExitCode',
  ].join('; ');

  // values travel through the environment so nothing has to be escaped for PowerShell
  const env = {
    ...process.env,
    ...(options && options.env),
    WINSV_FILE: file,
    WINSV_ARGS: [].concat(args || []).map(quoteArg).join(' '),
    WINSV_CWD: (options && options.cwd) || '',
  };
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { ...options, env })
    .catch(error => {
      if (typeof error.code === 'number' && !error.stderr) {
        error.message = `"${file}" failed with exit code ${error.code} (elevated).`;
      }
      throw error;
    });
}

/** Runs an executable and retries it elevated when it fails for lack of administrator rights. */
function execute(file, args, options) {
  return run(file, args, options).catch(error => {
    if (!ACCESS_DENIED.test(error.message)) { throw error }
    return isElevated().then(elevated => {
      if (elevated) { throw error }
      return elevate(file, args, options);
    });
  });
}

module.exports = { run, elevate, execute, isElevated };
