'use strict';

// Runs the acceptance tests, which install real Windows services and therefore need administrator rights.
// From a normal terminal this asks for them once (UAC) and prints the report when the tests are done.
//
//   npm run test:acceptance                 against the bundled wrapper
//   set WIN_SV_EXE=C:\path\to\wrapper.exe   then the same command, against another wrapper
//   npm run test:acceptance -- wrapper      only tests/acceptance/wrapper.js (or: library)

const path = require('path');
const { spawn } = require('child_process');

const win = require('../../index');

const SUITES = ['wrapper', 'library'];

async function main() {
  // an elevated process does not inherit the environment, so the wrapper under test travels as an argument
  const args = process.argv.slice(2);
  const at = args.indexOf('--wrapper');
  if (at >= 0) { process.env.WIN_SV_EXE = args.splice(at, 2)[1] }

  const unknown = args.filter(name => !SUITES.includes(name));
  if (unknown.length) { throw new Error(`Unknown suite "${unknown[0]}", expected: ${SUITES.join(', ')}`) }
  const suites = args.length ? args : SUITES;

  if (await win.cmd.isElevated()) {
    const files = suites.map(name => path.join(__dirname, name + '.js'));
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit', windowsHide: true });
    process.exitCode = await new Promise(resolve => child.once('exit', code => resolve(code === null ? 1 : code)));
    return;
  }

  console.log('Not elevated, asking for administrator rights. The report is printed when the tests are done...');
  const forwarded = process.env.WIN_SV_EXE ? ['--wrapper', path.resolve(process.env.WIN_SV_EXE)] : [];
  try {
    console.log(await win.cmd.elevate(process.execPath, [__filename, ...forwarded, ...suites], { encoding: 'utf8' }));
  } catch (error) {
    console.log(error.stdout || error.message);
    if (error.stdout && error.stderr) { console.error(error.stderr) }
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
