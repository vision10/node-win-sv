import { EventEmitter } from 'events';
import { ExecFileOptions } from 'child_process';

/** A number is a count of seconds, a string is passed to WinSW as is (`10 sec`, `5 min`, `1 hour`, `1 day`). */
export type Duration = number | string;
export type Arguments = string | string[];

export interface ServiceAccount {
  domain?: string;
  /** `LocalSystem`, `LocalService`, `NetworkService`, a user name, or a group managed account ending with `$` */
  account?: string;
  password?: string;
  /** grant the "Log on as a service" right to the account */
  allowservicelogon?: boolean;
  /** ask for the credentials at install time */
  prompt?: 'dialog' | 'console';
}

export interface LogOptions {
  mode?: 'append' | 'reset' | 'none' | 'roll-by-size' | 'roll-by-time' | 'roll-by-size-time';
  /** KB, default 10240 */
  sizeThreshold?: number;
  /** default 8 */
  keepFiles?: number;
  /** default `yyyyMMdd` */
  pattern?: string;
  autoRollAtTime?: string;
  zipOlderThanNumDays?: number;
  zipDateFormat?: string;
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
  /** Use another WinSW v3 executable than the bundled one. */
  winswExe?: string;

  logpath?: string;
  log?: LogOptions | LogOptions['mode'];
  priority?: 'idle' | 'belownormal' | 'normal' | 'abovenormal' | 'high' | 'realtime';
  startmode?: 'automatic' | 'manual' | 'disabled' | 'boot' | 'system';
  delayedAutoStart?: boolean;
  stoptimeout?: Duration;
  logOnAs?: boolean | string | ServiceAccount;

  /** Up to 3 recovery actions applied by Windows when the process exits with an error, the last one repeats. */
  onfailure?: Array<FailureAction | FailureAction['action']>;
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
  interactive?: boolean;
  beeponshutdown?: boolean;
  download?: Download | Download[];
}

export interface InstallOptions {
  /** replace the wrapper executable if it already exists */
  overwrite?: boolean;
  noElevate?: boolean;
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

export class Service extends EventEmitter {
  constructor(config: ServiceConfig);
  config: ServiceConfig;
  readonly id: string;
  readonly name: string;
  readonly winswPath: string;
  readonly exePath: string;
  readonly xmlPath: string;
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
  /** `manufacturer` must be 12 to 15 characters long */
  customize(output: string, manufacturer: string): Promise<string>;
  exec(command: string, args?: string[], silent?: boolean): Promise<string>;
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

export interface Task {
  ImageName: string;
  PID: string;
  SessionName: string;
  'Session#': string;
  MemUsage: string;
  Status?: string;
  UserName?: string;
  CPUTime?: string;
  WindowTitle?: string;
  [column: string]: string | undefined;
}

export const process: {
  start(serviceName: string): Promise<string>;
  stop(serviceName: string): Promise<string>;
  restart(serviceName: string): Promise<string>;
  kill(pidOrName: number | string, force?: boolean): Promise<string>;
  kill(pidOrName: number | string | undefined, filter?: string, force?: boolean): Promise<string>;
  list(filter?: string | RegExp | ((task: Task) => boolean), verbose?: boolean): Promise<Task[]>;
};

export const cmd: {
  run(file: string, args?: string[], options?: ExecFileOptions): Promise<string>;
  elevate(file: string, args?: string[], options?: ExecFileOptions): Promise<string>;
  execute(file: string, args?: string[], options?: ExecFileOptions): Promise<string>;
  isElevated(): Promise<boolean>;
};

export function generateXml(config: ServiceConfig): string;
