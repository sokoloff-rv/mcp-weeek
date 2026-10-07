import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { UserError } from '../errors.ts';
import { isObject, type JsonObject } from '../json.ts';
import { describeError, type Logger } from '../log.ts';
import type { Tool } from './tool.ts';

export const MODERN_VERSIONS: readonly string[] = ['2026-07-28'];
export const LEGACY_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedVersion: -32022,
} as const;

const CAPABILITIES = { tools: {} };

type RequestId = string | number;

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: RequestId | null;
  result?: JsonObject;
  error?: { code: number; message: string; data?: unknown };
};

class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type ServerOptions = {
  name: string;
  version: string;
  instructions: string;
  tools: readonly Tool[];
  log: Logger;
};

export class McpServer {
  readonly #options: ServerOptions;
  readonly #tools: Map<string, Tool>;

  constructor(options: ServerOptions) {
    this.#options = options;
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  async handle(message: unknown, signal: AbortSignal = new AbortController().signal): Promise<JsonRpcResponse | undefined> {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (isObject(message) && ('result' in message || 'error' in message)) return undefined;
      return errorResponse(readId(message), RPC_ERRORS.invalidRequest, 'Invalid JSON-RPC request');
    }
    const { id, method } = message;
    if (id === undefined) return undefined;
    if (typeof id !== 'string' && typeof id !== 'number') {
      return errorResponse(null, RPC_ERRORS.invalidRequest, 'Request id must be a string or a number');
    }
    const params = isObject(message.params) ? message.params : {};
    try {
      const modern = this.#isModernRequest(params);
      const result = await this.#dispatch(method, params, signal);
      return { jsonrpc: '2.0', id, result: modern ? this.#modernResult(result) : result };
    } catch (error) {
      if (error instanceof RpcError) return errorResponse(id, error.code, error.message, error.data);
      this.#options.log.error(`${method} failed: ${describeError(error)}`);
      return errorResponse(id, RPC_ERRORS.internal, 'Internal error');
    }
  }

  listen(input: Readable, output: Writable): Promise<void> {
    const inFlight = new Map<RequestId, AbortController>();
    const pending = new Set<Promise<void>>();
    const send = (response: JsonRpcResponse) => output.write(`${JSON.stringify(response)}\n`);
    const lines = createInterface({ input, crlfDelay: Infinity });

    lines.on('line', (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        send(errorResponse(null, RPC_ERRORS.parse, 'Parse error'));
        return;
      }
      if (Array.isArray(message)) {
        send(errorResponse(null, RPC_ERRORS.invalidRequest, 'Batch requests are not supported'));
        return;
      }
      const cancelledId = readCancelledId(message);
      if (cancelledId !== undefined) {
        inFlight.get(cancelledId)?.abort();
        return;
      }
      const id = readId(message);
      const controller = new AbortController();
      if (id !== null) inFlight.set(id, controller);
      const task: Promise<void> = this.handle(message, controller.signal)
        .then((response) => {
          if (response && !controller.signal.aborted) send(response);
        })
        .finally(() => {
          if (id !== null && inFlight.get(id) === controller) inFlight.delete(id);
          pending.delete(task);
        });
      pending.add(task);
    });

    return new Promise((resolve) => {
      lines.on('close', () => {
        void Promise.allSettled(pending).then(() => resolve());
      });
    });
  }

  #isModernRequest(params: JsonObject): boolean {
    const meta = isObject(params._meta) ? params._meta : {};
    const version = meta[META_PROTOCOL_VERSION];
    if (version === undefined || (typeof version === 'string' && LEGACY_VERSIONS.includes(version))) return false;
    if (typeof version !== 'string' || !MODERN_VERSIONS.includes(version)) {
      throw new RpcError(RPC_ERRORS.unsupportedVersion, 'Unsupported protocol version', {
        supported: SUPPORTED_VERSIONS,
        requested: version,
      });
    }
    if (!isObject(meta[META_CLIENT_CAPABILITIES])) {
      throw new RpcError(RPC_ERRORS.invalidParams, `Missing _meta["${META_CLIENT_CAPABILITIES}"]`);
    }
    return true;
  }

  #modernResult(result: JsonObject): JsonObject {
    const meta = isObject(result._meta) ? result._meta : {};
    return { resultType: 'complete', ...result, _meta: { ...meta, [META_SERVER_INFO]: this.#serverInfo() } };
  }

  #dispatch(method: string, params: JsonObject, signal: AbortSignal): Promise<JsonObject> | JsonObject {
    switch (method) {
      case 'initialize':
        return this.#initialize(params);
      case 'server/discover':
        return {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: CAPABILITIES,
          instructions: this.#options.instructions,
          _meta: { [META_SERVER_INFO]: this.#serverInfo() },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [...this.#tools.values()].map(describeTool) };
      case 'tools/call':
        return this.#callTool(params, signal);
      default:
        throw new RpcError(RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  #initialize(params: JsonObject): JsonObject {
    const requested = params.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: CAPABILITIES,
      serverInfo: this.#serverInfo(),
      instructions: this.#options.instructions,
    };
  }

  async #callTool(params: JsonObject, signal: AbortSignal): Promise<JsonObject> {
    const { name } = params;
    if (typeof name !== 'string') throw new RpcError(RPC_ERRORS.invalidParams, 'Tool name is required');
    const tool = this.#tools.get(name);
    if (!tool) throw new RpcError(RPC_ERRORS.invalidParams, `Unknown tool: ${name}`);
    const args = params.arguments ?? {};
    if (!isObject(args)) throw new RpcError(RPC_ERRORS.invalidParams, 'Tool arguments must be an object');
    try {
      return toolResult(await tool.handler(args, { signal }), false);
    } catch (error) {
      if (error instanceof UserError) return toolResult(error.message, true);
      if (signal.aborted) return toolResult('The request was cancelled.', true);
      this.#options.log.error(`Tool ${name} failed: ${describeError(error)}`);
      return toolResult(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  #serverInfo() {
    return { name: this.#options.name, version: this.#options.version };
  }
}

function describeTool(tool: Tool): JsonObject {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...tool.annotations },
  };
}

function toolResult(text: string, isError: boolean): JsonObject {
  return { content: [{ type: 'text', text }], isError };
}

function errorResponse(id: RequestId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

function readId(message: unknown): RequestId | null {
  if (!isObject(message)) return null;
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
}

function readCancelledId(message: unknown): RequestId | undefined {
  if (!isObject(message) || message.method !== 'notifications/cancelled' || message.id !== undefined) return undefined;
  const requestId = isObject(message.params) ? message.params.requestId : undefined;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}
