/**
 * A GhidraConnection that runs the ghidra-mcp worker locally, over stdio.
 *
 * The daemon path is: tool call -> handler.ts buildCommand (a per-tool parameter
 * whitelist, a couple of renames) -> worker CommandHandler -> result -> two
 * result fix-ups -> JSON. This module is the same chain with the HTTP hops
 * removed: it spawns packages/local-worker (StdioWorker, which wraps the very
 * same CommandHandler), opens the program read-only from the Ghidra Server, and
 * applies the identical whitelist and fix-ups here. The extraction code does not
 * know which transport it is talking to.
 *
 * Enabled by GHIDRA_LOCAL_WORKER=1. Configuration:
 *   GHIDRA_LOCAL_WORKER_CLASSPATH  dist/classpath.txt from packages/local-worker/build.sh
 *                                  (default: that file next to this package)
 *   GHIDRA_HOME                    the Ghidra 12.1.2 the jar was built against
 *   JAVA_HOME                      a JDK 21 (default: java on PATH)
 *   GHIDRA_SERVER_USER             the Ghidra Server account (read-only is enough)
 *   GHIDRA_SERVER_PASSWORD_FILE    file holding its password (default ~/.ghidra-export-password)
 *   GHIDRA_LOCAL_WORKER_PROJECT    local project dir (default ~/Library/Caches/ghidra-local-worker on macOS,
 *                                  <tmpdir>/ghidra-local-worker elsewhere; Ghidra rejects a path element
 *                                  that starts with '.', so ~/.cache cannot hold it)
 *   GHIDRA_MCP_DECOMPILER_THREADS  decompiler pool size (default: CPU count)
 *   GHIDRA_LOCAL_WORKER_XMX        JVM heap (default 8g)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { GhidraConnection } from './types.js';
import { recordRpc } from './connection.js';

export function localWorkerEnabled(): boolean {
  return process.env.GHIDRA_LOCAL_WORKER === '1';
}

type Params = Record<string, unknown>;
interface WorkerCommand { command: string; params: Params }

/** Keep only the listed keys, dropping undefined ones as JSON.stringify would. */
function pick(params: Params, keys: string[], renames: Record<string, string> = {}): Params {
  const out: Params = {};
  for (const key of keys) {
    const from = Object.entries(renames).find(([, to]) => to === key)?.[0] ?? key;
    if (params[from] !== undefined) out[key] = params[from];
  }
  return out;
}

/**
 * handler.ts `buildCommand`, for the tools the reconstruction calls. Anything
 * else is refused the way the daemon refuses an unknown tool, so a new call in
 * the extraction fails loudly here instead of silently taking a different path.
 */
export function buildWorkerCommand(tool: string, params: Params): WorkerCommand {
  switch (tool) {
    case 'list_programs':
      return { command: 'list_programs', params: pick(params, ['repo', 'folder', 'recursive', 'filter']) };
    case 'get_program_info':
      return { command: 'get_program_info', params: {} };
    case 'list_functions':
      return { command: 'list_functions', params: pick(params, ['offset', 'limit', 'filter', 'regex', 'namespace', 'includeChildren']) };
    case 'get_function_info':
      return { command: 'get_function_info', params: pick(params, ['address', 'name']) };
    case 'decompile':
      return { command: 'decompile', params: pick(params, ['address', 'name', 'timeout'], { decompileTimeout: 'timeout' }) };
    case 'batch_decompile':
      return {
        command: 'batch_decompile',
        params: pick(params, ['addresses', 'names', 'filter', 'regex', 'namespace', 'startAddress', 'endAddress', 'limit', 'decompileTimeout']),
      };
    case 'list_data_symbols':
      return { command: 'get_global_variables', params: pick(params, ['offset', 'limit', 'filter', 'regex', 'segment', 'sortBy', 'dataType']) };
    case 'read_data_value':
      return { command: 'read_data_value', params: pick(params, ['address']) };
    case 'list_data_types':
      return { command: 'list_data_types', params: pick(params, ['offset', 'limit', 'filter', 'regex', 'category']) };
    case 'get_data_type':
      return { command: 'get_data_type', params: pick(params, ['name', 'category']) };
    case 'list_segments':
      return { command: 'list_segments', params: {} };
    case 'list_strings':
      return { command: 'list_strings', params: pick(params, ['offset', 'limit', 'minLength', 'filter', 'regex']) };
    case 'list_namespaces':
      return { command: 'list_namespaces', params: pick(params, ['offset', 'limit', 'filter', 'regex']) };
    case 'list_comments':
      return { command: 'list_comments', params: pick(params, ['offset', 'limit', 'type', 'inFunction']) };
    case 'execute_script': {
      const p = pick(params, ['code', 'filePath', 'language', 'timeout', 'sandbox'], { scriptTimeout: 'timeout' });
      p.language = (params.language as string | undefined) || 'python';
      return { command: 'execute_script', params: p };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/** handler.ts `handleToolCall` / `dispatchToWorker` result fix-ups. */
export function fixUpResult(tool: string, result: unknown): unknown {
  if (tool === 'execute_script' && result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.output === 'string') {
      try { r.output = JSON.parse(r.output.trim()); } catch { /* not JSON: leave raw text */ }
    }
  }
  if (tool === 'decompile' && result && typeof result === 'object' && 'rawPseudocode' in result) {
    delete (result as Record<string, unknown>).rawPseudocode;
  }
  if (tool === 'batch_decompile' && result && typeof result === 'object' && 'results' in result) {
    const arr = (result as { results: unknown[] }).results;
    if (Array.isArray(arr)) {
      for (const r of arr) {
        if (r && typeof r === 'object' && 'rawPseudocode' in r) delete (r as Record<string, unknown>).rawPseudocode;
      }
    }
  }
  return result;
}

interface Pending { tool: string; resolve: (v: unknown) => void; reject: (e: Error) => void; started: number; timer: NodeJS.Timeout }

class StdioWorkerProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited: Error | null = null;
  /** False while the program is still opening: the loop must stay alive for the ready line. */
  private opened = false;
  readonly ready: Promise<{ openMs: number }>;

  constructor(serverHostPort: string, repo: string, program: string) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cpFile = process.env.GHIDRA_LOCAL_WORKER_CLASSPATH
      ?? path.resolve(here, '../../local-worker/dist/classpath.txt');
    if (!existsSync(cpFile)) {
      throw new Error(`local worker not built: ${cpFile} is missing (run packages/local-worker/build.sh)`);
    }
    const classpath = readFileSync(cpFile, 'utf8').trim();
    const user = process.env.GHIDRA_SERVER_USER;
    if (!user) throw new Error('GHIDRA_SERVER_USER is not set (the Ghidra Server account for the local worker)');
    const pwFile = process.env.GHIDRA_SERVER_PASSWORD_FILE ?? path.join(homedir(), '.ghidra-export-password');
    const password = readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '');
    const project = process.env.GHIDRA_LOCAL_WORKER_PROJECT ?? (process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Caches', 'ghidra-local-worker')
      : path.join(tmpdir(), 'ghidra-local-worker'));
    mkdirSync(project, { recursive: true });
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java';
    const threads = process.env.GHIDRA_MCP_DECOMPILER_THREADS ?? String(cpus().length);

    this.child = spawn(java, [
      `-Xmx${process.env.GHIDRA_LOCAL_WORKER_XMX ?? '8g'}`,
      '-Duser.language=en',
      '-Duser.country=US',
      `-Dghidra.mcp.decompiler.threads=${threads}`,
      `-Dghidra.mcp.read.threads=${threads}`,
      '-cp', classpath,
      'com.ghidramcp.local.StdioWorker',
      '--ghidra-server', serverHostPort,
      '--repo', repo,
      '--program', program,
      '--server-user', user,
      '--project', project,
    ], {
      env: { ...process.env, GHIDRA_SERVER_PASSWORD: password },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const log = process.env.GHIDRA_LOCAL_WORKER_LOG;
    this.child.stderr.on('data', (chunk: Buffer) => { if (log) process.stderr.write(chunk); });

    let onReady!: (v: { openMs: number }) => void;
    let onFail!: (e: Error) => void;
    this.ready = new Promise((resolve, reject) => { onReady = resolve; onFail = reject; });

    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      const msg = JSON.parse(line) as { ready?: boolean; openMs?: number; id?: number; success?: boolean; result?: unknown; error?: string };
      if (msg.ready) { this.opened = true; this.updateRef(); onReady({ openMs: msg.openMs ?? 0 }); return; }
      const p = this.pending.get(msg.id!);
      if (!p) return;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      this.updateRef();
      if (!msg.success) { p.reject(new Error(msg.error || 'Command failed')); return; }
      // The daemon hands the result through JSON twice; one round here is the same value.
      recordRpc(p.tool, line.length, Date.now() - p.started);
      p.resolve(fixUpResult(p.tool, msg.result));
    });

    this.child.on('exit', (code, signal) => {
      this.exited = new Error(`local Ghidra worker exited (${signal ?? `code ${code}`}); set GHIDRA_LOCAL_WORKER_LOG=1 to see its log`);
      this.opened = true;
      onFail(this.exited);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(this.exited); }
      this.pending.clear();
    });
    process.on('exit', () => { this.child.kill('SIGKILL'); });
    this.updateRef();
  }

  /** Hold the event loop open only while a command is in flight. */
  private updateRef(): void {
    const busy = !this.opened || this.pending.size > 0;
    for (const s of [this.child, this.child.stdout, this.child.stderr, this.child.stdin] as unknown as Array<{ ref(): void; unref(): void }>) {
      if (busy) s.ref(); else s.unref();
    }
  }

  async call<T>(tool: string, params: Params, timeoutMs: number): Promise<T> {
    if (this.exited) throw this.exited;
    const { command, params: workerParams } = buildWorkerCommand(tool, params);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.updateRef();
        reject(new Error(`local worker: ${tool} timed out after ${timeoutMs}ms`));
      }, timeoutMs + 5000);
      this.pending.set(id, { tool, resolve: resolve as (v: unknown) => void, reject, started: Date.now(), timer });
      this.updateRef();
      this.child.stdin.write(JSON.stringify({ id, command, params: workerParams }) + '\n');
    });
  }

  shutdown(): void {
    if (this.exited) return;
    this.child.stdin.write(JSON.stringify({ id: 0, command: 'shutdown' }) + '\n');
    this.child.stdin.end();
  }
}

const workers = new Map<string, StdioWorkerProcess>();

/**
 * `createConnection` for the local worker. `projectPath` is the
 * ghidra://host[:port]/Repo URL and `programPath` the path inside the repo,
 * exactly as for the daemon.
 */
export async function createLocalWorkerConnection(projectPath: string, programPath?: string): Promise<GhidraConnection> {
  const m = /^ghidra:\/\/([^/:]+)(?::(\d+))?\/([^/]+)(\/.*)?$/.exec(projectPath);
  if (!m) throw new Error(`local worker needs a ghidra://host[:port]/Repo project path, got ${projectPath}`);
  const [, host, port = '13100', repo, embedded] = m;
  const program = programPath ?? embedded;
  if (!program) throw new Error(`local worker needs a program path for ${projectPath}`);

  const key = `${host}:${port}/${repo}${program}`;
  let worker = workers.get(key);
  if (!worker) {
    worker = new StdioWorkerProcess(`${host}:${port}`, repo, program);
    workers.set(key, worker);
    const { openMs } = await worker.ready;
    console.log(`Local Ghidra worker opened ${repo}${program} read-only in ${(openMs / 1000).toFixed(1)}s`);
  } else {
    await worker.ready;
  }
  const w = worker;
  return {
    sessionId: `local:${key}`,
    unpaged: true,
    async sendCommand<T = unknown>(command: string, params: Params = {}): Promise<T> {
      const timeout = (params._commandTimeout as number) || 30000;
      const workerParams = { ...params };
      delete workerParams._commandTimeout;
      return w.call<T>(command, workerParams, timeout);
    },
    async close(): Promise<void> {
      // Shared by every connection to the same program, like a daemon session.
    },
  };
}

/** Stop every local worker this process started. */
export function shutdownLocalWorkers(): void {
  for (const w of workers.values()) w.shutdown();
  workers.clear();
}
