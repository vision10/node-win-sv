'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { quoteArg } = require('./winsw');

// Only used by `execute`, which keeps the 0.x behaviour. Everything in this package decides
// on exit codes and on `isElevated` instead, because these messages change with the display language.
const ACCESS_DENIED = /access is denied|access denied|accessdenied|requires elevation/i;
const ERROR_ACCESS_DENIED = 5;
const ERROR_CANCELLED = 1223;
const MAX_COMMAND_LINE = 30000;

/** Absolute path of a Windows system tool, so a same-named program on PATH is never picked up. */
function sys(name) {
  return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name);
}

const shells = {};
/**
 * The PowerShell used for WMI queries and elevation, in order of preference:
 * the WIN_SV_POWERSHELL environment variable, PowerShell 7 (pwsh) from its default location,
 * pwsh found on PATH, then Windows PowerShell 5.1 where Windows still ships it.
 * The scripts of this package run unchanged on both.
 * @param {boolean} [trusted] skip PATH: used for the process started as administrator, which must
 *   not be an executable picked up from a folder any user can write to
 */
function powershellExe(trusted) {
  const key = trusted ? 'trusted' : 'any';
  if (!shells[key]) {
    const candidates = powershellCandidates(trusted);
    shells[key] = candidates.find(file => fs.existsSync(file)) || candidates[candidates.length - 1];
  }
  return shells[key];
}

/** Where PowerShell is looked for, most preferred first. The last entry is Windows PowerShell 5.1. */
function powershellCandidates(trusted, env) {
  env = env || process.env;
  const programs = [...new Set([env.ProgramW6432, env.ProgramFiles].filter(Boolean))];
  const onPath = trusted ? [] : String(env.PATH || env.Path || '').split(';').filter(Boolean);
  return [
    env.WIN_SV_POWERSHELL,
    ...programs.map(dir => path.join(dir, 'PowerShell', '7', 'pwsh.exe')),
    ...onPath.map(dir => path.join(dir, 'pwsh.exe')),
    sys('WindowsPowerShell\\v1.0\\powershell.exe'),
  ].filter(Boolean);
}

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
    // `input` is written to the standard input of the process, which is then closed
    const { input, ...rest } = options || {};
    const opts = { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...rest };

    const child = execFile(file, [].concat(args || []).map(String), opts, (error, stdout, stderr) => {
      stdout = String(stdout || '').trim();
      stderr = String(stderr || '').trim();
      if (!error) { return resolve(stdout) }
      reject(failure(stderr || stdout || error.message, error.code, stdout, stderr));
    });
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* the process ended without reading it */ });
      child.stdin.end(String(input));
    }
  });
}

function failure(message, code, stdout, stderr) {
  return Object.assign(new Error(message), { code, stdout: stdout || '', stderr: stderr || '' });
}

function encode(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Runs a PowerShell script, see `powershellExe`. Output is UTF-8.
 * @param {string} script
 * @param {object} [options] child_process.execFile options
 */
function powershell(script, options) {
  const prelude = '$ProgressPreference = "SilentlyContinue"; $ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; ';
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    // An error is written by the script itself, as its bare message: left to PowerShell it comes out as CLIXML
    // from Windows PowerShell and as coloured text with a prefix ("Exception: ...") from PowerShell 7.
    encode(prelude + 'try {\n' + script + '\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }')
  ];
  return module.exports.run(powershellExe(), args, options).catch(error => {
    // what PowerShell reports by itself (a script it cannot parse): no colours
    const plain = error.stderr.replace(/\x1b\[[0-9;]*m/g, '');
    if (plain !== error.stderr) {
      if (error.message === error.stderr) { error.message = plain }
      error.stderr = plain;
    }
    // with -EncodedCommand Windows PowerShell reports errors as CLIXML, keep the text only
    if (error.stderr.startsWith('#< CLIXML')) {
      const text = (error.stderr.match(/<S S="Error">[\s\S]*?<\/S>/g) || [])
        .map(part => part.replace(/<[^>]+>/g, '').replace(/_x000D__x000A_/g, '\n').replace(/_x([0-9A-F]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))))
        .join('').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
      error.stderr = text;
      error.message = text.split('\n')[0] || error.stdout || error.message;
    }
    throw error;
  });
}

let elevated;
/** Resolves true when the current process has administrator rights. */
function isElevated() {
  if (!elevated) {
    // the integrity level is reported as a SID, the same in every display language:
    // S-1-16-12288 high (administrator), S-1-16-16384 system
    elevated = run(sys('whoami.exe'), ['/groups', '/fo', 'csv', '/nh'])
      .then(out => /S-1-16-(12288|16384)\b/.test(out), () => false);
  }
  return elevated;
}

// Runs inside the elevated PowerShell: executes each command, captures its output
// and writes the results where the non elevated side can read them.
const ELEVATED_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$job = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@JOB@')) | ConvertFrom-Json
$results = @()
foreach ($c in $job.commands) {
  $code = 0
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $c.file
    $psi.Arguments = $c.args
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    if ($job.utf8) { $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8 }
    if ($job.cwd) { $psi.WorkingDirectory = $job.cwd }
    $p = [System.Diagnostics.Process]::Start($psi)
    $o = $p.StandardOutput.ReadToEndAsync()
    $e = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    $code = $p.ExitCode
    $results += @{ code = $code; stdout = $o.Result; stderr = $e.Result }
  } catch {
    $code = 1
    $results += @{ code = 1; stdout = ''; stderr = $_.Exception.Message }
  }
  if ($code -ne 0) { break }
}
[IO.File]::WriteAllText($job.out, (ConvertTo-Json -InputObject @($results) -Compress), (New-Object Text.UTF8Encoding $false))
`;

/**
 * Runs several executables as administrator behind a single UAC prompt, one after the other,
 * stopping at the first one that fails.
 * @param {Array<[string, string[]?]|{file: string, args?: string[]}>} commands
 * @param {{cwd?: string, encoding?: 'utf8'}} [options] `encoding` when the commands write UTF-8 (Node.js does)
 *   instead of the console code page (Windows tools do)
 * @returns {Promise<string[]>} the trimmed stdout of each command
 */
async function elevateAll(commands, options) {
  const list = [].concat(commands || []).map(command => {
    const [file, args] = Array.isArray(command) ? command : [command && command.file, command && command.args];
    if (!file) { throw new Error('Command not provided!') }
    return { file: String(file), args: [].concat(args || []).map(quoteArg).join(' ') };
  });
  if (!list.length) { return [] }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-sv-elevate-'));
  const out = path.join(dir, 'result.json');
  try {
    const job = { commands: list, out, cwd: (options && options.cwd) || '', utf8: Boolean(options && options.encoding === 'utf8') };
    const inner = encode(ELEVATED_SCRIPT.replace('@JOB@', Buffer.from(JSON.stringify(job), 'utf8').toString('base64')));
    if (inner.length > MAX_COMMAND_LINE) { throw new Error('The elevated command is too long.') }

    // the script travels through the environment so nothing has to be escaped
    const launcher = [
      '$a = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + $env:WINSV_ELEVATED',
      `try { $p = Start-Process -FilePath '${powershellExe(true).replace(/'/g, "''")}' -ArgumentList $a -Verb RunAs -WindowStyle Hidden -Wait -PassThru }`,
      `catch { [Console]::Error.WriteLine($_.Exception.Message); exit ${ERROR_CANCELLED} }`,
      'exit $p.ExitCode',
    ].join('\n');
    await module.exports.powershell(launcher, { env: { ...process.env, WINSV_ELEVATED: inner } });

    if (!fs.existsSync(out)) { throw new Error('The elevated process did not report a result.') }
    const results = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\ufeff/, ''));
    return results.map(result => {
      const stdout = String(result.stdout || '').trim();
      const stderr = String(result.stderr || '').trim();
      if (result.code !== 0) {
        throw failure(stderr || stdout || `Command failed with exit code ${result.code} (elevated).`, result.code, stdout, stderr);
      }
      return stdout;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Runs an executable as administrator (triggers a UAC prompt) and waits for it to finish.
 * Rejects with code 1223 when the prompt is declined.
 * @returns {Promise<string>} the trimmed stdout
 */
function elevate(file, args, options) {
  if (!file) { return Promise.reject(new Error('Command not provided!')) }
  return module.exports.elevateAll([[file, args]], options).then(results => results[0]);
}

/** Runs an executable that needs administrator rights: directly when elevated, behind a UAC prompt otherwise. */
async function admin(file, args, options) {
  return (await module.exports.isElevated()) ? module.exports.run(file, args, options) : module.exports.elevate(file, args, options);
}

/**
 * Runs an executable and retries it elevated when it fails for lack of administrator rights.
 * The failure is recognised by exit code 5 or by the English error text; pass `elevateOnFailure: true`
 * when any failure of a non elevated process should be retried.
 */
function execute(file, args, options) {
  const { elevateOnFailure, ...opts } = options || {};
  return module.exports.run(file, args, opts).catch(async error => {
    const denied = elevateOnFailure || error.code === ERROR_ACCESS_DENIED || ACCESS_DENIED.test(error.message);
    if (!denied || await module.exports.isElevated()) { throw error }
    return module.exports.elevate(file, args, opts);
  });
}

module.exports = { sys, run, powershell, powershellExe, powershellCandidates, isElevated, elevate, elevateAll, admin, execute };
