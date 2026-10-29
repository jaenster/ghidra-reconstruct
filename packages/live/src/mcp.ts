/**
 * The daemon's control surface: an MCP server over stdio, plus a small HTTP
 * JSON-RPC endpoint for anything that cannot spawn a stdio child.
 *
 * Every tool here is read-mostly except `rebuild`, `full_regen`, `retry_merge`,
 * `pause` and `resume`, and those five are the whole point: the live loop is
 * allowed to run unattended precisely because an operator can interrogate what
 * it did and stop it without reading a log file. The `proposal_*` tools are the
 * opt-in per-proposal commit boundary (see proposal.ts); nothing calls them on
 * the ordinary path.
 *
 * This module knows nothing about snapshots, git or codegen. It talks to a
 * `LiveController` that `main.ts` implements, so the transport and the loop can
 * each be reasoned about on their own.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/** What the loop exposes. Implemented by `main.ts`. */
export interface LiveController {
  status(): Promise<unknown> | unknown;
  changesApplied(limit: number): Promise<unknown> | unknown;
  impact(symbol: string): Promise<unknown> | unknown;
  rebuildNow(): Promise<unknown>;
  fullRegen(): Promise<unknown>;
  diffFunction(address: string): Promise<unknown>;
  mergeStatus(): Promise<unknown> | unknown;
  retryMerge(): Promise<unknown>;
  pause(): Promise<unknown> | unknown;
  resume(): Promise<unknown> | unknown;
  proposalBegin(args: Record<string, unknown>): Promise<unknown>;
  proposalCommit(args: Record<string, unknown>): Promise<unknown>;
  proposalAbort(args: Record<string, unknown>): Promise<unknown> | unknown;
}

const TOOLS: Tool[] = [
  {
    name: 'status',
    description:
      'Everything about the loop right now: the change sequence the model is at, model counts, ' +
      'when the last rebuild ran and how long it took, the merge state, and whether the loop is ' +
      'paused or has stopped applying events because it needs a full resync.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_changes_applied',
    description: 'The most recent change events that were folded into the model, newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return. Default 50.' },
      },
    },
  },
  {
    name: 'impact',
    description:
      'Which generated files a symbol reaches: the file it is emitted into, plus the files ' +
      'holding every function that calls it. This is what a rebuild would rewrite.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Function or global name, or an address.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'rebuild',
    description:
      'Regenerate the tree now from the current model, then commit and merge. Takes ~10 minutes. ' +
      'Also the way out of a needs-full-resync stop: it is the operator saying the model is trusted.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'full_regen',
    description:
      'The oracle. Generate into a scratch directory and diff it against the live tree, reporting ' +
      'every file that differs. A clean diff is the evidence that the incremental path is exact.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'diff_function',
    description:
      "The emitted C++ for one function next to Ghidra's current decompilation of it. " +
      'The direct check for whether the tree is behind Ghidra for that symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Function entry point, e.g. 005011f0.' },
      },
      required: ['address'],
    },
  },
  {
    name: 'merge_status',
    description: 'The last merge of the regen branch into the modified worktree, and any conflicts it left.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'retry_merge',
    description: 'Merge the regen branch into the modified worktree again, after a conflict was resolved.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pause',
    description: 'Stop releasing change batches. The subscription stays up and events keep queueing, so nothing is lost.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resume',
    description: 'Release batches again, starting with everything that queued while paused.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'proposal_begin',
    description:
      'Call BEFORE applying a community proposal to Ghidra. Holds change batches back and records ' +
      'the journal head, so the proposal\'s changes can later be committed on their own. Returns ' +
      '{proposal, since, startedAt, expiresAt}. One proposal at a time; the hold ends on ' +
      'proposal_commit, proposal_abort or expiry, after which ordinary batching resumes.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: { type: 'number', description: 'Proposal number.' },
        holdMs: { type: 'number', description: 'How long to hold before giving up. Default 900000 (15 min), max 3600000.' },
      },
      required: ['proposal'],
    },
  },
  {
    name: 'proposal_commit',
    description:
      'Call AFTER the proposal was applied as one transaction and checked in to Ghidra. Waits for the ' +
      'check-in in the journal, commits any earlier pending changes as an ordinary batch, then commits ' +
      'the regen output of exactly the proposal\'s changes, authored by the contributor with ' +
      'Proposal/Reviewed-by/Approved-by trailers. Returns {sha, batchCommit, window, transaction, merge}. ' +
      'Refuses (nothing attributed) when the window holds another writer\'s transaction. Idempotent: ' +
      'a proposal already committed returns its sha with alreadyCommitted. dryRun reports the window, ' +
      'the isolation verdict and the predicted units/files without changing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        proposal: { type: 'number', description: 'Proposal number; becomes the "Proposal: #<n>" trailer.' },
        login: { type: 'string', description: 'Contributor GitHub login.' },
        userId: { type: 'number', description: 'Contributor GitHub numeric user id (noreply address).' },
        ghidraVersion: { type: 'number', description: 'The Ghidra version the proposal was checked in as.' },
        title: { type: 'string', description: 'One-line proposal title for the subject. Optional.' },
        reviewedBy: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Reviewed-by trailer value(s). Optional.',
        },
        approvedBy: { type: 'string', description: 'Approved-by trailer. Default "jaenster".' },
        sinceSeq: { type: 'number', description: 'Window start (exclusive). Default: the seq proposal_begin recorded.' },
        untilSeq: { type: 'number', description: 'Window end (inclusive). Default: the first check-in after sinceSeq.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the check-in. Default 120000.' },
        expectTxDescription: { type: 'string', description: 'Refuse unless the window\'s transaction has this name.' },
        dryRun: { type: 'boolean', description: 'Report what would be committed; change nothing.' },
      },
      required: ['proposal', 'login', 'userId', 'ghidraVersion'],
    },
  },
  {
    name: 'proposal_abort',
    description:
      'Give up on a proposal: release the hold so ordinary batching resumes. Its changes, if any, ' +
      'then land in the next ordinary batch commit.',
    inputSchema: {
      type: 'object',
      properties: { proposal: { type: 'number', description: 'Proposal number.' } },
      required: ['proposal'],
    },
  },
];

type ToolArgs = Record<string, unknown>;

async function dispatch(controller: LiveController, name: string, args: ToolArgs): Promise<unknown> {
  switch (name) {
    case 'status': return controller.status();
    case 'get_changes_applied': return controller.changesApplied(numberArg(args.limit, 50));
    case 'impact': return controller.impact(stringArg(args.symbol, 'symbol'));
    case 'rebuild': return controller.rebuildNow();
    case 'full_regen': return controller.fullRegen();
    case 'diff_function': return controller.diffFunction(stringArg(args.address, 'address'));
    case 'merge_status': return controller.mergeStatus();
    case 'retry_merge': return controller.retryMerge();
    case 'pause': return controller.pause();
    case 'resume': return controller.resume();
    case 'proposal_begin': return controller.proposalBegin(args);
    case 'proposal_commit': return controller.proposalCommit(args);
    case 'proposal_abort': return controller.proposalAbort(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`'${name}' is required and must be a non-empty string`);
  }
  return value;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** MCP content envelope. Everything is JSON text — these are structured answers. */
function asContent(payload: unknown): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function asError(e: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  // A refused proposal is an expected answer with a machine-readable reason, not
  // a crash: hand back the code and the sentence, not a stack trace.
  if (e instanceof Error && e.name === 'ProposalError') {
    const code = (e as Error & { code?: string }).code;
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code, error: e.message }, null, 2) }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: e instanceof Error ? (e.stack ?? e.message) : String(e) }],
    isError: true,
  };
}

export function createLiveMcpServer(controller: LiveController): Server {
  const server = new Server(
    { name: 'ghidra-live', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      return asContent(await dispatch(controller, name, (args ?? {}) as ToolArgs));
    } catch (e) {
      // Returned as tool content rather than thrown: a tool that fails is a
      // normal answer to an operator's question, and a protocol-level error
      // would drop the reason on the floor.
      return asError(e);
    }
  });

  return server;
}

export async function serveStdio(controller: LiveController): Promise<Server> {
  const server = createLiveMcpServer(controller);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * JSON-RPC over one POST, mirroring the daemon's own `/mcp/rpc`.
 *
 * `tools/list` and `tools/call` only. It exists so a shell or a running agent
 * can ask the loop a question with curl, which is how a stuck rebuild actually
 * gets diagnosed — a stdio transport needs a client that owns the process.
 */
export function serveHttp(
  controller: LiveController,
  port: number,
  host = '127.0.0.1',
): Promise<{ close: () => Promise<void>; port: number }> {
  const http = createServer((req, res) => { void handle(controller, req, res); });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    // 127.0.0.1 by default: these tools rewrite a git worktree and start a ten
    // minute job, and the endpoint has no authentication of its own.
    http.listen(port, host, () => {
      resolve({
        port: (http.address() as { port: number }).port,
        close: () => new Promise<void>(done => http.close(() => done())),
      });
    });
  });
}

async function handle(
  controller: LiveController,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;

  let request: { id?: unknown; method?: string; params?: { name?: string; arguments?: ToolArgs } };
  try {
    request = JSON.parse(body || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }

  const id = request.id ?? null;
  const reply = (result: unknown) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };

  try {
    if (request.method === 'tools/list') {
      reply({ tools: TOOLS });
      return;
    }
    if (request.method === 'tools/call') {
      const name = request.params?.name;
      if (!name) throw new Error('params.name is required');
      reply(asContent(await dispatch(controller, name, request.params?.arguments ?? {})));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    }));
  } catch (e) {
    reply(asError(e));
  }
}
