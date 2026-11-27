import { EventEmitter } from 'events';
import { ExecFileOptions } from 'child_process';

/** A number is a count of seconds, a string is passed to the wrapper as is (`10 sec`, `5 min`, `1 hour`, `1 day`). */
export type Duration = number | string;
export type Arguments = string | string[];

export interface ServiceAccount {
  domain?: string;
  /** `LocalSystem`, `LocalService`, `NetworkService`, a user name, or a group managed account ending with `$` */
  account?: string;
  /**
   * Password of a user account. It is handed to the wrapper when the service is installed and never
   * written to the configuration file. Without it the wrapper asks for the password at that moment.
   */
  password?: string;
  /** How to ask when no password is given, default `dialog`. Without `account` the user name is asked too. */
  prompt?: 'dialog' | 'console';
  /** grant the "Log on as a service" right to the account */
  allowservicelogon?: boolean;
}

export interface LogOptions {
  mode?: 'append' | 'reset' | 'none' | 'roll-by-size' | 'roll-by-time' | 'roll-by-size-time';
  /** KB, default 10240 */
  sizeThreshold?: number;
  /** roll-by-size: default 8. For the time based modes, the number of dated files kept (not with WinSW). */
  keepFiles?: number;
  /** default `yyyyMMdd` */
  pattern?: string;
  autoRollAtTime?: string;
  zipOlderThanNumDays?: number;
  zipDateFormat?: string;
  /** Not with WinSW: the error output goes to the same file as the output */
  combine?: boolean;
  /** Not with WinSW: a date in front of each line, `true` or a format such as `yyyy-MM-dd HH:mm:ss` */
  timestamp?: boolean | string;
  /** Not with WinSW: the size based modes start a new file each time the service starts */
  rollOnStart?: boolean;
  /** Not with WinSW: `false` for no `<id>.wrapper.log` */
  wrapper?: boolean;
}

export interface FailureAction {
  action: 'restart' | 'reboot' | 'none';
  delay?: Duration;
}

export interface HookCommand {
  executable: string;
  arguments?: Arguments;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface Download {
  from: string;
  to: string;
  failOnError?: boolean;
  proxy?: string;
  auth?: 'sspi' | 'basic';
  unsecureAuth?: boolean;
  user?: string;
  password?: string;
}

export interface ServiceConfig {
  /** Service id, defaults to `name`. */
  id?: string;
  /** Display name. */
  name?: string;
  description?: string;
  /** Script to run. Required unless `execPath` is given. */
  script?: string;
  /** Executable running the script, defaults to the current node.exe. */
  execPath?: string;
  execOptions?: Arguments;
  nodeOptions?: Arguments;
  scriptOptions?: Arguments;
  cwd?: string;
  workingdirectory?: string;
  env?: Record<string, string | number> | Array<{ name: string; value: string | number }>;
  depend?: string | string[];

  /** Where the wrapper folder is created, defaults to the script directory. */
  winswDest?: string;
  /** Name of the wrapper folder, defaults to `daemon`. */
  winswDir?: string;
  /** Wrapper executable to use instead of the bundled winsv, WinSW v3 for one. The WIN_SV_EXE environment variable does the same. */
  wrapperExe?: string;

  logpath?: string;
  log?: LogOptions | LogOptions['mode'];
  priority?: 'idle' | 'belownormal' | 'normal' | 'abovenormal' | 'high' | 'realtime';
  startmode?: 'automatic' | 'manual' | 'disabled' | 'boot' | 'system';
  delayedAutoStart?: boolean;
  stoptimeout?: Duration;
  /** Account running the service, default LocalSystem. A string is an account name. */
  logOnAs?: boolean | string | ServiceAccount;

  /** Up to 3 recovery actions applied by Windows when the process exits with an error, the last one repeats. */
  onfailure?: FailureAction | FailureAction['action'] | Array<FailureAction | FailureAction['action']>;
  /** Time without failure after which Windows resets the failure count, default 1 day. */
  resetfailure?: Duration;

  securityDescriptor?: string;
  startarguments?: Arguments;
  stopexecutable?: string;
  stoparguments?: Arguments;
  prestart?: HookCommand;
  poststart?: HookCommand;
  prestop?: HookCommand;
  poststop?: HookCommand;
  preshutdown?: boolean;
  preshutdownTimeout?: Duration;
  autoRefresh?: boolean;
  /** Not with WinSW: processes the service started detached (and unref'd) are not stopped with it */
  keepDetached?: boolean;
  interactive?: boolean;
  /** Only with WinSW as the wrapper */
  beeponshutdown?: boolean;
  /** Only with WinSW as the wrapper */
  download?: Download | Download[];
}

export interface InstallOptions {
  /** also start the service, behind the same UAC prompt */
  start?: boolean;
  /** replace the wrapper executable if it already exists */
  overwrite?: boolean;
  noElevate?: boolean;
  /** account for this installation, replaces `logOnAs` */
  user?: string;
  username?: string;
  pass?: string;
  password?: string;
}

export interface UninstallOptions {
  removeFiles?: boolean;
  force?: boolean;
  noElevate?: boolean;
  noWait?: boolean;
}

export type ServiceStatus =
  | 'NonExistent'
  | 'Inactive (stopped)'
  | 'Active (running)'
  | 'Active (starting)'
  | 'Active (stopping)'
  | 'Active (paused)'
  | 'Active (pausing)'
  | 'Active (continuing)';

export type LogType = 'out' | 'err' | 'wrapper';

export class Service extends EventEmitter {
  constructor(config: ServiceConfig);
  config: ServiceConfig;
  readonly id: string;
  readonly name: string;
  readonly winswPath: string;
  readonly exePath: string;
  readonly xmlPath: string;
  readonly logPath: string;
  readonly exists: boolean;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  install(options?: InstallOptions): Promise<string>;
  uninstall(options?: UninstallOptions): Promise<string>;
  uninstall(removeFiles?: boolean, forceStop?: boolean, noElevate?: boolean, noWait?: boolean): Promise<string>;
  start(noElevate?: boolean, noWait?: boolean): Promise<string>;
  stop(force?: boolean, noElevate?: boolean, noWait?: boolean): Promise<string>;
  restart(noElevate?: boolean, force?: boolean): Promise<string>;
  selfRestart(): Promise<string>;
  refresh(options?: Partial<ServiceConfig>, noElevate?: boolean): Promise<string>;
  /** Only with WinSW as the wrapper. `manufacturer` must be 12 to 15 characters long */
  customize(output: string, manufacturer: string): Promise<string>;
  /** Path of the current log file, undefined when there is none yet. */
  logFile(type?: LogType): string | undefined;
  /** Last lines of a log file, 100 lines of the script output by default. */
  logs(options?: LogType | { type?: LogType; lines?: number }): Promise<string>;
  /** Calls `listener` with whatever is appended to a log file until `close()` is called. */
  watchLogs(listener: (text: string) => void): { close(): void };
  watchLogs(options: LogType | { type?: LogType; interval?: number }, listener: (text: string) => void): { close(): void };
  exec(command: string, args?: string[], silent?: boolean): Promise<string>;
  /** Runs several wrapper commands in order behind a single UAC prompt. */
  execAll(commands: Array<[string, string[]?]>, noElevate?: boolean): Promise<string[]>;
}

export class EventLogger extends EventEmitter {
  constructor(source?: string, isSystem?: boolean);
  constructor(config?: { source?: string; eventLog?: 'APPLICATION' | 'SYSTEM'; isSystem?: boolean });
  source: string;
  eventLog: 'APPLICATION' | 'SYSTEM';
  isRegistered(): Promise<boolean>;
  registerEventSource(): Promise<true>;
  info(message: string, code?: number): Promise<string>;
  warn(message: string, code?: number): Promise<string>;
  error(message: string, code?: number): Promise<string>;
  success(message: string, code?: number): Promise<string>;
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  description: string;
  state: 'running' | 'stopped' | 'start-pending' | 'stop-pending' | 'paused' | 'pause-pending' | 'continue-pending' | 'unknown';
  startMode: 'automatic' | 'manual' | 'disabled' | 'boot' | 'system' | 'unknown';
  /** 0 when the service is not running */
  pid: number;
  account: string;
  /** command line of the service */
  path: string;
  exitCode: number;
}

export const services: {
  /** Details of one service by name, undefined when it does not exist. */
  get(name: string): Promise<ServiceInfo | undefined>;
  list(filter?: string | RegExp | ((service: ServiceInfo) => boolean)): Promise<ServiceInfo[]>;
  /** Does nothing when the service is already running. Rejects with code 1060 when it does not exist. */
  start(name: string): Promise<string>;
  /** Does nothing when the service is already stopped. Dependent services are stopped too. */
  stop(name: string): Promise<string>;
  restart(name: string): Promise<string>;
};

export interface Task {
  name: string;
  pid: number;
  sessionId: number;
  /** working set, in bytes */
  memory: number;
  /** the fields below are missing when the list comes from `tasklist` */
  ppid?: number;
  path?: string;
  commandLine?: string;
  /** ISO 8601 date */
  startTime?: string;
  /** the fields below are added by `verbose`, or come from `tasklist` */
  sessionName?: string;
  status?: string;
  user?: string;
  cpuTime?: string;
  windowTitle?: string;
}

export interface ListOptions {
  /** add sessionName, status, user, cpuTime and windowTitle (slow) */
  verbose?: boolean;
  /** `wmi` by default, falling back to `tasklist` when it fails */
  source?: 'wmi' | 'tasklist';
}

export const process: {
  /** Same as `services.start`, `services.stop` and `services.restart`. */
  start(serviceName: string): Promise<string>;
  stop(serviceName: string): Promise<string>;
  restart(serviceName: string): Promise<string>;
  kill(pidOrName: number | string, force?: boolean): Promise<string>;
  kill(pidOrName: number | string | undefined, filter?: string, force?: boolean): Promise<string>;
  list(filter?: string | RegExp | ((task: Task) => boolean), options?: boolean | ListOptions): Promise<Task[]>;
};

export interface ElevatedCommand {
  file: string;
  args?: string[];
}

export const cmd: {
  /** Absolute path of a tool in System32. */
  sys(name: string): string;
  run(file: string, args?: string[], options?: ExecFileOptions): Promise<string>;
  /** Runs a PowerShell script (7 when installed, else Windows PowerShell 5.1), output is UTF-8. */
  powershell(script: string, options?: ExecFileOptions): Promise<string>;
  /** Path of the PowerShell in use. `trusted` ignores PATH, as done for the process started as administrator. */
  powershellExe(trusted?: boolean): string;
  isElevated(): Promise<boolean>;
  /** Runs as administrator behind a UAC prompt. Rejects with code 1223 when the prompt is declined. */
  elevate(file: string, args?: string[], options?: { cwd?: string }): Promise<string>;
  /** Runs several commands as administrator behind one UAC prompt, stopping at the first failure. */
  elevateAll(commands: Array<[string, string[]?] | ElevatedCommand>, options?: { cwd?: string }): Promise<string[]>;
  /** Runs directly when elevated, behind a UAC prompt otherwise. */
  admin(file: string, args?: string[], options?: ExecFileOptions): Promise<string>;
  /** Runs, and retries elevated on access denied (exit code 5, English text, or any failure with `elevateOnFailure`). */
  execute(file: string, args?: string[], options?: ExecFileOptions & { elevateOnFailure?: boolean }): Promise<string>;
};

export function generateXml(config: ServiceConfig): string;

declare const win: {
  Service: typeof Service;
  EventLogger: typeof EventLogger;
  services: typeof services;
  process: typeof process;
  cmd: typeof cmd;
  generateXml: typeof generateXml;
};
export default win;
