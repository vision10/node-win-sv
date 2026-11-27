'use strict';

// Which PowerShell is used: 7 (pwsh) first, Windows PowerShell 5.1 as the fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { cmd } = require('../index');
const { tmpDir } = require('./helpers');

const cmdJs = path.join(__dirname, '..', 'lib', 'cmd.js');
const windowsPowerShell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const same = (a, b) => assert.deepEqual(a.map(file => file.toLowerCase()), b.map(file => file.toLowerCase()));

test('PowerShell 7 comes first, Windows PowerShell 5.1 last', () => {
  const env = { ProgramFiles: 'C:\\Program Files', ProgramW6432: 'C:\\Program Files', PATH: 'C:\\tools;D:\\bin' };
  same(cmd.powershellCandidates(false, env), [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\tools\\pwsh.exe',
    'D:\\bin\\pwsh.exe',
    windowsPowerShell,
  ]);
});

test('the process started as administrator is never looked up on PATH', () => {
  const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Users\\bob\\bin' };
  same(cmd.powershellCandidates(true, env), ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', windowsPowerShell]);
});

test('WIN_SV_POWERSHELL is looked at before anything else', () => {
  const env = { WIN_SV_POWERSHELL: 'D:\\ps\\pwsh.exe', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\tools' };
  assert.equal(cmd.powershellCandidates(false, env)[0], 'D:\\ps\\pwsh.exe');
  assert.equal(cmd.powershellCandidates(true, env)[0], 'D:\\ps\\pwsh.exe');
});

test('a 32-bit process also looks in the 64-bit Program Files, and PATH may be spelled Path', () => {
  const env = { ProgramFiles: 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files', Path: 'C:\\tools' };
  same(cmd.powershellCandidates(false, env), [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe',
    'C:\\tools\\pwsh.exe',
    windowsPowerShell,
  ]);
});

/** Resolves `[any, trusted]` as chosen by a fresh process: the choice is made once per process. */
function chosen(env) {
  const script = `const cmd = require(${JSON.stringify(cmdJs)}); console.log(JSON.stringify([cmd.powershellExe(), cmd.powershellExe(true)]))`;
  // environment names are case insensitive on Windows (PATH is usually spelled Path)
  const names = Object.keys(env).map(name => name.toLowerCase());
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name.toLowerCase())));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script], { env: { ...inherited, ...env }, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))));
  });
}

test('the first candidate that exists is used', async t => {
  // an empty file named pwsh.exe: enough to be found, it is never run
  const dir = tmpDir(t);
  const pwsh = path.join(dir, 'pwsh.exe');
  fs.writeFileSync(pwsh, '');

  const [any, trusted] = await chosen({ WIN_SV_POWERSHELL: pwsh });
  assert.deepEqual([any, trusted], [pwsh, pwsh]);

  // a path that does not exist is skipped
  const [fallback] = await chosen({ WIN_SV_POWERSHELL: path.join(dir, 'missing.exe') });
  assert.equal(fallback, cmd.powershellExe());
});

test('the PowerShell chosen on this machine exists and runs the scripts of the package', async () => {
  assert.ok(fs.existsSync(cmd.powershellExe()));
  assert.ok(fs.existsSync(cmd.powershellExe(true)));
  const isPwsh = /pwsh\.exe$/i.test(cmd.powershellExe());
  const major = Number(await cmd.powershell('$PSVersionTable.PSVersion.Major'));
  assert.ok(isPwsh ? major >= 7 : major === 5, `PowerShell ${major}`);

  const query = 'ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Service -Filter "Name=\'EventLog\'" | ForEach-Object { $_.Name })';
  assert.deepEqual(JSON.parse(await cmd.powershell(query)), ['EventLog']);
});
