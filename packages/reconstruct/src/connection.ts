/**
 * Connection to Ghidra via the live MCP daemon
 *
 * Uses the daemon's /mcp/rpc JSON-RPC endpoint to send commands.
 * Auto-discovers existing sessions by programPath, or creates new ones.
 */

import type { GhidraConnection } from './types.js';

/**
 * Optional bearer auth for an OAuth-protected daemon. Reads GHIDRA_MCP_TOKEN.
 */
function authHeaders(): Record<string, string> {
  const tok = process.env.GHIDRA_MCP_TOKEN;
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

/**
 * Is this a transient network error worth retrying?
 *
 * A `kubectl port-forward` tunnel (especially over a tailscale exit node)
 * periodically drops its long-lived stream under sustained extraction
 * traffic while the API server stays healthy. Those manifest as `fetch
 * failed` / ECONNRESET / connection-refused and recover within ~1-2s once
 * the port-forward re-establishes (or a self-healing loop restarts it).
 * 5xx from the daemon is also transient (worker restart). We must NOT retry
 * genuine application errors (json.error, "Error:" text, HTTP 4xx).
 */
function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    const cause = (err as { cause?: { code?: string } }).cause?.code?.toLowerCase() ?? '';
    return (
      err.name === 'TimeoutError' ||
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('econnrefused') ||
      msg.includes('socket hang up') ||
      msg.includes('terminated') ||
      msg.startsWith('daemon returned http 5') ||
      cause.includes('econnreset') ||
      cause.includes('econnrefused') ||
      cause.includes('und_err')
    );
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * How chatty was this run? Every phase goes through `rpcCallOnce`, so counting
 * here gives the true HTTP round-trip count and response volume against the
 * remote daemon — the number that decides whether batch sizes are tuned or
 * whether latency is the wall.
 */
export interface RpcStats {
  calls: number;
  retries: number;
  bytesIn: number;
  /** Total time spent inside fetch+parse, summed across calls (may overlap). */
  ms: number;
  /** Per-tool breakdown, so "146 list_functions pages" is visible, not inferred. */
  byTool: Map<string, { calls: number; bytesIn: number; ms: number }>;
}

const rpcStats: RpcStats = { calls: 0, retries: 0, bytesIn: 0, ms: 0, byTool: new Map() };

export function getRpcStats(): RpcStats {
  return rpcStats;
}

export function resetRpcStats(): void {
  rpcStats.calls = 0;
  rpcStats.retries = 0;
  rpcStats.bytesIn = 0;
  rpcStats.ms = 0;
  rpcStats.byTool.clear();
}

function recordRpc(tool: string, bytesIn: number, ms: number): void {
  rpcStats.calls++;
  rpcStats.bytesIn += bytesIn;
  rpcStats.ms += ms;
  let entry = rpcStats.byTool.get(tool);
  if (!entry) {
    entry = { calls: 0, bytesIn: 0, ms: 0 };
    rpcStats.byTool.set(tool, entry);
  }
  entry.calls++;
  entry.bytesIn += bytesIn;
  entry.ms += ms;
}

/** Top tools by wall time, e.g. "batch_decompile 268x/612.1s/54MB". */
export function summarizeRpcStats(limit = 6): string[] {
  if (rpcStats.calls === 0) return [];
  const rows = [...rpcStats.byTool.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, limit);
  const lines = [
    `RPC: ${rpcStats.calls} calls, ${rpcStats.retries} retries, ` +
    `${(rpcStats.ms / 1000).toFixed(1)}s in-flight, ${(rpcStats.bytesIn / 1e6).toFixed(1)} MB received`,
  ];
  for (const [tool, s] of rows) {
    lines.push(
      `  ${tool.padEnd(24)} ${String(s.calls).padStart(6)}x ` +
      `${(s.ms / 1000).toFixed(1)}s`.padStart(9) +
      ` ${(s.bytesIn / 1e6).toFixed(1)} MB` +
      (s.calls > 1 ? `  (${(s.ms / s.calls).toFixed(0)} ms/call)` : '')
    );
  }
  return lines;
}

/**
 * Send a JSON-RPC call to the daemon's /mcp/rpc endpoint.
 *
 * Retries transient network failures (port-forward tunnel drops, worker
 * 5xx) with exponential backoff so a brief tunnel blip doesn't abort a
 * multi-thousand-call extraction run.
 */
async function rpcCall<T>(
  daemonUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = 30000,
  maxRetries = 6
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await rpcCallOnce<T>(daemonUrl, toolName, args, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isTransient(err)) throw err;
      rpcStats.retries++;
      const delay = Math.min(500 * 2 ** attempt, 8000);
      console.warn(
        `[rpc] transient failure on ${toolName} (attempt ${attempt + 1}/${maxRetries + 1}): ${(err as Error).message} — retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function rpcCallOnce<T>(
  daemonUrl: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const startedAt = Date.now();
  const resp = await fetch(`${daemonUrl}/mcp/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });

  if (!resp.ok) {
    throw new Error(`Daemon returned HTTP ${resp.status}: ${resp.statusText}`);
  }

  // Read as text first so the response size is measurable — the JSON is parsed
  // from the same string, so this costs nothing extra.
  const raw = await resp.text();
  recordRpc(toolName, raw.length, Date.now() - startedAt);
  const json = JSON.parse(raw) as {
    error?: { message: string };
    result?: { content?: Array<{ type: string; text: string }> };
  };

  if (json.error) {
    throw new Error(json.error.message);
  }

  const text = json.result?.content?.[0]?.text;
  if (!text) {
    throw new Error('Empty response from daemon');
  }
  if (text.startsWith('Error:')) {
    throw new Error(text);
  }

  return JSON.parse(text) as T;
}

interface DaemonSession {
  id: string;
  binaryPath: string;
  programPath?: string;
  status: string;
}

/**
 * Create a connection to Ghidra via the live daemon
 *
 * Auto-discovers an existing session matching the programPath,
 * or creates a new one if none exists.
 */
export async function createConnection(
  projectPath: string,
  daemonUrl = 'http://localhost:8432',
  programPath?: string,
): Promise<GhidraConnection> {
  // Check daemon is reachable
  try {
    await fetch(`${daemonUrl}/status`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(
      `Daemon not running at ${daemonUrl}. Start with: ghidra-mcp start -p 8432 -f`
    );
  }

  // List sessions and find a matching one
  const sessions = await rpcCall<DaemonSession[]>(daemonUrl, 'list_sessions', {});

  let sessionId = sessions.find(
    s => s.programPath === programPath && s.status === 'ready'
  )?.id;

  // Create session if not found
  if (!sessionId) {
    console.log(`No ready session for ${programPath}, creating one...`);
    // For a Ghidra Server (ghidra://) URL the daemon needs the program path
    // embedded in the URL — a bare repo URL + separate programPath is rejected.
    const isGhidraUrl = projectPath.startsWith('ghidra://');
    const createArgs = isGhidraUrl && programPath
      ? { binaryPath: `${projectPath}${programPath}`, autoAnalyze: false }
      : { binaryPath: projectPath, programPath, autoAnalyze: false };
    const session = await rpcCall<DaemonSession>(
      daemonUrl,
      'create_session',
      createArgs,
      // Worker startup. A fresh checkout downloads the whole program DB from the
      // remote Ghidra server, which can far exceed 2 min; reused checkouts are
      // near-instant. Configurable so a cold first checkout doesn't get aborted.
      Number(process.env.GHIDRA_CREATE_SESSION_TIMEOUT_MS) || 120000
    );
    sessionId = session.id;
    console.log(`Session created: ${sessionId}`);
  } else {
    console.log(`Reusing existing session: ${sessionId}`);
  }

  return {
    sessionId,

    async sendCommand<T = unknown>(
      command: string,
      params: Record<string, unknown> = {}
    ): Promise<T> {
      const timeout = (params._commandTimeout as number) || 30000;
      const workerParams = { ...params };
      delete workerParams._commandTimeout;

      return rpcCall<T>(daemonUrl, command, { ...workerParams, sessionId }, timeout);
    },

    async close(): Promise<void> {
      // Don't close the session — it's shared with MCP clients
    },
  };
}

/**
 * Close a connection
 */
export async function closeConnection(connection: GhidraConnection): Promise<void> {
  await connection.close();
}

/**
 * Check if the daemon is available
 */
export async function isDaemonAvailable(daemonUrl = 'http://localhost:8432'): Promise<boolean> {
  try {
    const resp = await fetch(`${daemonUrl}/status`, { signal: AbortSignal.timeout(2000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * List existing sessions from the daemon
 */
export async function listSessions(
  daemonUrl = 'http://localhost:8432'
): Promise<Array<{ sessionId: string; binaryPath: string; status: string }>> {
  try {
    const sessions = await rpcCall<DaemonSession[]>(daemonUrl, 'list_sessions', {});
    return sessions.map(s => ({
      sessionId: s.id,
      binaryPath: s.binaryPath,
      status: s.status,
    }));
  } catch {
    return [];
  }
}

// =============================================================================
// Export All C with Caching
// =============================================================================

import { getExportAllCCache, type ExportAllCResult } from './cache.js';

/**
 * Options for exportAllC
 */
export interface ExportAllCOptions {
  /** Timeout for decompilation per function in seconds (default: 30) */
  decompileTimeout?: number;

  /** Overall command timeout in milliseconds (default: 10 minutes) */
  commandTimeout?: number;

  /** Include type definitions (default: true) */
  includeTypes?: boolean;

  /** Include header code (default: true) */
  includeHeaders?: boolean;

  /** Force re-export even if cache is valid (default: false) */
  forceRefresh?: boolean;
}

/**
 * Get the current cache version from the Ghidra worker
 */
export async function getCacheVersion(
  connection: GhidraConnection
): Promise<number> {
  const result = await connection.sendCommand<{ cacheVersion: number }>(
    'get_cache_version'
  );
  return result.cacheVersion;
}

/**
 * Export all pseudo-C code from Ghidra with caching
 *
 * The result is cached based on the worker's cache version, which is
 * automatically invalidated when any modifications are made (renames,
 * comments, type changes, etc.)
 */
export async function exportAllC(
  connection: GhidraConnection,
  options: ExportAllCOptions = {}
): Promise<ExportAllCResult> {
  const {
    decompileTimeout = 30,
    commandTimeout = 600000, // 10 minutes default
    includeTypes = true,
    includeHeaders = true,
    forceRefresh = false,
  } = options;

  const cache = getExportAllCCache();

  // Check cache validity
  if (!forceRefresh) {
    const currentVersion = await getCacheVersion(connection);
    const cached = cache.get(currentVersion);
    if (cached) {
      return cached;
    }
  }

  // Export from Ghidra
  const result = await connection.sendCommand<ExportAllCResult>('export_all_c', {
    decompileTimeout,
    includeTypes,
    includeHeaders,
    _commandTimeout: commandTimeout,
  });

  // Cache the result
  cache.set(result);

  return result;
}

/**
 * Check if the export cache is valid (without fetching)
 */
export async function isExportCacheValid(
  connection: GhidraConnection
): Promise<boolean> {
  const cache = getExportAllCCache();
  const currentVersion = await getCacheVersion(connection);
  return cache.isValid(currentVersion);
}

/**
 * Clear the export cache
 */
export function clearExportCache(): void {
  const cache = getExportAllCCache();
  cache.clear();
}
