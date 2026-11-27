'use strict';

// Any Windows service, by name: query, start, stop, restart.

const cmd = require('./cmd');

const ERROR_SERVICE_DOES_NOT_EXIST = 1060;

// The values returned by WMI are the same in every display language.
const QUERY = `
$f = $null
if ($env:WINSV_SERVICE) { $f = "Name='" + $env:WINSV_SERVICE.Replace('\\', '\\\\').Replace("'", "\\'") + "'" }
$r = if ($f) { Get-CimInstance Win32_Service -Filter $f } else { Get-CimInstance Win32_Service }
ConvertTo-Json -Compress -InputObject @($r | ForEach-Object { @{
  name = $_.Name; displayName = $_.DisplayName; description = $_.Description; state = $_.State; startMode = $_.StartMode
  pid = [int]$_.ProcessId; account = $_.StartName; path = $_.PathName; exitCode = [int]$_.ExitCode
} })
`;

function normalise(row) {
  const startMode = String(row.startMode || '').toLowerCase();
  return {
    name: row.name,
    displayName: row.displayName || row.name,
    description: row.description || '',
    // running, stopped, start-pending, stop-pending, paused, pause-pending, continue-pending
    state: String(row.state || '').toLowerCase().replace(/ /g, '-'),
    // automatic, manual, disabled, boot, system
    startMode: startMode === 'auto' ? 'automatic' : startMode,
    pid: row.pid || 0,
    account: row.account || '',
    path: row.path || '',
    exitCode: row.exitCode || 0,
  };
}

async function query(name) {
  const out = await cmd.powershell(QUERY, { env: { ...process.env, WINSV_SERVICE: name || '' } });
  return JSON.parse(out || '[]').map(normalise);
}

function notFound(name) {
  return Object.assign(new Error(`The service "${name}" does not exist.`), { code: ERROR_SERVICE_DOES_NOT_EXIST, stdout: '', stderr: '' });
}

async function existing(name) {
  if (!name) { throw new Error('A service name is required.') }
  const service = await module.exports.get(name);
  if (!service) { throw notFound(name) }
  return service;
}

const net = (action, name) => [cmd.sys('net.exe'), [action, name, '/y']];

module.exports = {
  /**
   * Details of one service, undefined when it does not exist.
   * @param {string} name the service name (not the display name), case insensitive
   */
  async get(name) {
    return (await query(String(name)))[0];
  },

  /**
   * Installed services.
   * @param {string|RegExp|function} [filter] text contained in the name or display name, a RegExp tested against both, or a predicate
   */
  async list(filter) {
    const services = (await query()).sort((a, b) => a.name.localeCompare(b.name));
    if (!filter) { return services }
    if (typeof filter === 'function') { return services.filter(filter) }
    if (filter instanceof RegExp) { return services.filter(s => filter.test(s.name) || filter.test(s.displayName)) }
    const text = String(filter).toLowerCase();
    return services.filter(s => s.name.toLowerCase().includes(text) || s.displayName.toLowerCase().includes(text));
  },

  /** Starts a service and waits for it. Does nothing when it is already running. */
  async start(name) {
    const service = await existing(name);
    if (service.state === 'running') { return '' }
    // the service exists and is not running, so a failure without administrator rights is retried with them
    return cmd.execute(...net('start', service.name), { elevateOnFailure: true });
  },

  /** Stops a service, and the services depending on it, and waits for it. Does nothing when it is already stopped. */
  async stop(name) {
    const service = await existing(name);
    if (service.state === 'stopped') { return '' }
    return cmd.execute(...net('stop', service.name), { elevateOnFailure: true });
  },

  /** Stops then starts a service, behind a single UAC prompt when one is needed. */
  async restart(name) {
    const service = await existing(name);
    if (service.state === 'stopped') { return module.exports.start(service.name) }
    const commands = [net('stop', service.name), net('start', service.name)];
    if (!(await cmd.isElevated())) { return (await cmd.elevateAll(commands)).join('\n') }
    const out = [];
    for (const [file, args] of commands) { out.push(await cmd.run(file, args)) }
    return out.join('\n');
  },
};
