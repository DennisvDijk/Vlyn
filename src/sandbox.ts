import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { CapabilityManifest } from './capabilities.ts';
import { splitCommand } from './capabilities.ts';

/**
 * Child-process confinement for a check command.
 * Node's --permission flag is a seatbelt for trusted code: the Node docs say it
 * does not stop malicious code. On the Node 24 build we measured, it denies
 * file reads outside --allow-fs-read and does not stop net.connect.
 * Network denial is unshare --net (Linux user namespaces), bubblewrap, or
 * sandbox-exec when those exist. Landlock and seccomp are not applied: this
 * process has no native helper and we do not ship one.
 */
export type Isolation = {
  driver: string;
  filesystem: 'node-permission' | 'bubblewrap' | 'seatbelt' | 'none';
  network: 'unshare' | 'bubblewrap' | 'seatbelt' | 'none';
  landlock: false;
  seccomp: false;
  isolates: boolean;
};

export type GovernedResult = {
  command: string;
  exitCode: number | null;
  output: string;
  isolation: Isolation;
};

const secretName = /(?:key|token|secret|password|credential|authorization)/iu;
const maxOutput = 30_000;

let cachedUnshare: boolean | undefined;
let cachedBwrap: boolean | undefined;
let cachedSeatbelt: boolean | undefined;

function probe(file: string, args: string[]): boolean {
  try {
    const result = spawnSyncStatus(file, args);
    return result === 0;
  } catch {
    return false;
  }
}

function spawnSyncStatus(file: string, args: string[]): number | null {
  const child = spawnSync(file, args, { stdio: 'ignore', timeout: 5_000 });
  return child.status;
}

export function unshareAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  cachedUnshare ??= probe('unshare', ['--user', '--map-root-user', '--net', 'true']);
  return cachedUnshare;
}

export function bubblewrapAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  cachedBwrap ??= probe('bwrap', ['--version']);
  return cachedBwrap;
}

export function seatbeltAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  cachedSeatbelt ??= probe('sandbox-exec', ['-n', 'no-network', 'true']);
  return cachedSeatbelt;
}

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name === 'NODE_OPTIONS' || name === 'NODE_REPL_EXTERNAL_MODULE') continue;
    if (secretName.test(name)) continue;
    next[name] = value;
  }
  return next;
}

export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value && secretName.test(name) && value.length >= 6)
    .map(([, value]) => value as string);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}

export function seatbeltProfile(cwd: string): string {
  const quote = (value: string) => JSON.stringify(value);
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/System") (subpath "/Library") (subpath "/opt/homebrew") (subpath "/dev"))',
    `(allow file-read* (subpath ${quote(cwd)}))`,
    `(allow file-write* (subpath ${quote(cwd)}))`,
    '(deny network*)',
  ].join('\n');
}

export function bubblewrapArgs(cwd: string, inner: string[]): string[] {
  return [
    '--unshare-net', '--unshare-pid', '--die-with-parent',
    '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--bind', cwd, cwd,
    '--chdir', cwd,
    '--',
    ...inner,
  ];
}

export type Launch = {
  file: string;
  args: string[];
  shell: boolean;
  isolation: Isolation;
};

/** Choose the strongest confinement that is actually present. */
export function planLaunch(command: string, cwd: string, manifest: CapabilityManifest): Launch {
  const tokens = splitCommand(command);
  const nodeCmd = tokens[0] === 'node' || tokens[0] === 'node.exe';
  const permission = ['--permission', `--allow-fs-read=${cwd}`, `--allow-fs-write=${cwd}`];
  const nodeInner = nodeCmd ? [process.execPath, ...permission, ...tokens.slice(1)] : tokens;
  if (process.platform === 'linux' && bubblewrapAvailable()) {
    return {
      file: 'bwrap', args: bubblewrapArgs(cwd, nodeInner), shell: false,
      isolation: { driver: 'bubblewrap', filesystem: 'bubblewrap', network: 'bubblewrap', landlock: false, seccomp: false, isolates: true },
    };
  }
  if (process.platform === 'linux' && unshareAvailable()) {
    return {
      file: 'unshare', args: ['--user', '--map-root-user', '--net', '--', ...nodeInner], shell: false,
      isolation: {
        driver: nodeCmd ? 'unshare-net+node-permission' : 'unshare-net',
        filesystem: nodeCmd ? 'node-permission' : 'none',
        network: 'unshare', landlock: false, seccomp: false, isolates: true,
      },
    };
  }
  if (process.platform === 'darwin' && seatbeltAvailable()) {
    return {
      file: 'sandbox-exec', args: ['-p', seatbeltProfile(cwd), '--', ...tokens], shell: false,
      isolation: { driver: 'seatbelt', filesystem: 'seatbelt', network: 'seatbelt', landlock: false, seccomp: false, isolates: true },
    };
  }
  if (nodeCmd) {
    return {
      file: process.execPath, args: [...permission, ...tokens.slice(1)], shell: false,
      isolation: { driver: 'node-permission', filesystem: 'node-permission', network: 'none', landlock: false, seccomp: false, isolates: true },
    };
  }
  return {
    file: command, args: [], shell: true,
    isolation: { driver: 'gate-only', filesystem: 'none', network: 'none', landlock: false, seccomp: false, isolates: false },
  };
}

export function posture(): Isolation {
  const launch = planLaunch('node -e "process.exit(0)"', process.cwd(), {
    read: [], write: [], commands: [], network: 'none', endpoints: [], grants: [],
  });
  return launch.isolation;
}

function capture(file: string, args: string[], shell: boolean, cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number | null; output: string }> {
  return new Promise(done => {
    const child = shell
      ? spawn(file, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
      : spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    let output = '';
    const append = (data: Buffer) => { output = (output + data.toString()).slice(-maxOutput); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', error => done({ exitCode: null, output: error.message }));
    child.once('close', (exitCode, signal) => {
      if (signal) output += `\nCheck ended by ${signal}.`;
      done({ exitCode, output });
    });
  });
}

export async function runGoverned(options: {
  command: string;
  cwd: string;
  manifest: CapabilityManifest;
  env?: NodeJS.ProcessEnv;
  requireSandbox?: boolean;
}): Promise<GovernedResult> {
  const env = options.env ?? process.env;
  const launch = planLaunch(options.command, options.cwd, options.manifest);
  if (manifestBlocksNetwork(options.manifest) && launch.isolation.network === 'none' && options.requireSandbox) {
    throw new Error(`Refusing ${options.command}: this OS has no network sandbox (${launch.isolation.driver}). Landlock and seccomp are not active.`);
  }
  if (options.requireSandbox && !launch.isolation.isolates) {
    throw new Error(`Refusing ${options.command}: only the in-process gate is available (${launch.isolation.driver}).`);
  }
  const result = await capture(launch.file, launch.args, launch.shell, options.cwd, scrubEnv(env));
  return { command: options.command, ...result, isolation: launch.isolation };
}

function manifestBlocksNetwork(manifest: CapabilityManifest): boolean {
  return manifest.network !== 'unrestricted';
}

export async function measureOverhead(cwd: string): Promise<{
  driver: string;
  network: Isolation['network'];
  filesystem: Isolation['filesystem'];
  plainMs: number;
  sandboxedMs: number;
  rssBytes: number;
}> {
  const env = scrubEnv(process.env);
  const plainStart = performance.now();
  await capture(process.execPath, ['-e', 'process.exit(0)'], false, cwd, env);
  const plainMs = performance.now() - plainStart;
  const boxStart = performance.now();
  const boxed = await runGoverned({
    command: 'node -e "process.exit(0)"',
    cwd,
    manifest: { read: [cwd], write: [cwd], commands: ['node -e "process.exit(0)"'], network: 'none', endpoints: [], grants: [] },
    env,
  });
  return {
    driver: boxed.isolation.driver,
    network: boxed.isolation.network,
    filesystem: boxed.isolation.filesystem,
    plainMs: Math.round(plainMs),
    sandboxedMs: Math.round(performance.now() - boxStart),
    rssBytes: process.memoryUsage().rss,
  };
}
