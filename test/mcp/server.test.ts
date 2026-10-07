import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { UserError } from '../../src/errors.ts';
import { LEGACY_VERSIONS, McpServer, MODERN_VERSIONS, RPC_ERRORS } from '../../src/mcp/server.ts';
import type { Tool } from '../../src/mcp/tool.ts';
import { captureLogger } from '../helpers/log.ts';

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

function echoTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'echo',
    title: 'Echo',
    description: 'Returns the text argument',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    handler: async (args) => `echo: ${String(args.text)}`,
    ...overrides,
  };
}

function createServer(tools: Tool[] = [echoTool()]) {
  const log = captureLogger();
  const server = new McpServer({ name: 'test-server', version: '1.2.3', instructions: 'Call echo first.', tools, log });
  return { server, log };
}

describe('McpServer: legacy handshake', () => {
  it('answers initialize with the requested legacy version', async () => {
    const { server } = createServer();
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    });
    assert.deepEqual(response, {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'Call echo first.',
      },
    });
  });

  it('falls back to the latest legacy version for an unknown one', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
    assert.equal(response?.result?.protocolVersion, LEGACY_VERSIONS[0]);
  });

  it('does not answer notifications', async () => {
    const { server } = createServer();
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  });

  it('answers ping with an empty result', async () => {
    const { server } = createServer();
    assert.deepEqual(await server.handle({ jsonrpc: '2.0', id: 'p', method: 'ping' }), { jsonrpc: '2.0', id: 'p', result: {} });
  });
});

describe('McpServer: modern requests', () => {
  it('implements server/discover', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: MODERN_META } });
    assert.equal(response?.result?.resultType, 'complete');
    assert.deepEqual(response?.result?.supportedVersions, [...MODERN_VERSIONS, ...LEGACY_VERSIONS]);
    assert.deepEqual(response?.result?.capabilities, { tools: {} });
    assert.equal(response?.result?.ttlMs, 3_600_000);
    assert.equal(response?.result?.cacheScope, 'public');
    assert.deepEqual(response?.result?._meta, {
      'io.modelcontextprotocol/serverInfo': { name: 'test-server', version: '1.2.3' },
    });
  });

  it('adds resultType and serverInfo to every modern result', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: MODERN_META } });
    assert.equal(response?.result?.resultType, 'complete');
    assert.ok(response?.result?._meta);
  });

  it('adds caching hints only to cacheable modern results', async () => {
    const { server } = createServer();
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: MODERN_META } });
    assert.equal(list?.result?.ttlMs, 3_600_000);
    assert.equal(list?.result?.cacheScope, 'public');
    const call = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', _meta: MODERN_META } });
    assert.equal(call?.result?.ttlMs, undefined);
    const legacy = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(legacy?.result?.ttlMs, undefined);
  });

  it('rejects an unsupported protocol version with the supported list', async () => {
    const { server } = createServer();
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
    });
    assert.equal(response?.error?.code, RPC_ERRORS.unsupportedVersion);
    assert.deepEqual(response?.error?.data, { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: '1900-01-01' });
  });

  it('rejects a modern request without client capabilities', async () => {
    const { server } = createServer();
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    assert.equal(response?.error?.code, RPC_ERRORS.invalidParams);
  });

  it('serves a legacy version passed in _meta without modern decoration', async () => {
    const { server } = createServer();
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
    });
    assert.equal(response?.result?.resultType, undefined);
    assert.ok(Array.isArray(response?.result?.tools));
  });
});

describe('McpServer: tools', () => {
  it('lists tools with schemas and annotations', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(response?.result?.tools, [
      {
        name: 'echo',
        title: 'Echo',
        description: 'Returns the text argument',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        annotations: { title: 'Echo', readOnlyHint: true },
      },
    ]);
  });

  it('calls a tool and returns text content', async () => {
    const { server } = createServer();
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    });
    assert.deepEqual(response?.result, { content: [{ type: 'text', text: 'echo: hi' }], isError: false });
  });

  it('returns a protocol error for an unknown tool', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
    assert.deepEqual(response?.error, { code: RPC_ERRORS.invalidParams, message: 'Unknown tool: nope' });
  });

  it('rejects non-object arguments', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: [1] } });
    assert.equal(response?.error?.code, RPC_ERRORS.invalidParams);
  });

  it('turns a UserError into a tool execution error', async () => {
    const { server, log } = createServer([
      echoTool({
        handler: async () => {
          throw new UserError('Column "x" not found');
        },
      }),
    ]);
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    assert.deepEqual(response?.result, { content: [{ type: 'text', text: 'Column "x" not found' }], isError: true });
    assert.deepEqual(log.lines, []);
  });

  it('logs unexpected errors and still answers with a tool error', async () => {
    const { server, log } = createServer([
      echoTool({
        handler: async () => {
          throw new TypeError('boom');
        },
      }),
    ]);
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } });
    assert.equal(response?.result?.isError, true);
    assert.match(String((response?.result?.content as { text: string }[])[0]?.text), /boom/);
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0] ?? '', /Tool echo failed: TypeError: boom/);
  });
});

describe('McpServer: JSON-RPC errors', () => {
  it('rejects a message without method', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 7 });
    assert.deepEqual(response, { jsonrpc: '2.0', id: 7, error: { code: RPC_ERRORS.invalidRequest, message: 'Invalid JSON-RPC request' } });
  });

  it('rejects a null id', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: null, method: 'ping' });
    assert.equal(response?.error?.code, RPC_ERRORS.invalidRequest);
  });

  it('answers an unknown method with method not found', async () => {
    const { server } = createServer();
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    assert.equal(response?.error?.code, RPC_ERRORS.methodNotFound);
  });

  it('ignores responses sent by the client', async () => {
    const { server } = createServer();
    assert.equal(await server.handle({ jsonrpc: '2.0', id: 1, result: {} }), undefined);
  });
});

describe('McpServer: stdio framing', () => {
  async function exchange(server: McpServer, lines: string[]): Promise<unknown[]> {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));
    const done = server.listen(input, output);
    for (const line of lines) input.write(`${line}\n`);
    input.end();
    await done;
    return chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  it('reads one message per line and writes one response per line', async () => {
    const { server } = createServer();
    const responses = await exchange(server, [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      '',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'a\nb' } } }),
    ]);
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[0], { jsonrpc: '2.0', id: 1, result: {} });
    assert.deepEqual((responses[1] as { result: unknown }).result, {
      content: [{ type: 'text', text: 'echo: a\nb' }],
      isError: false,
    });
  });

  it('answers malformed JSON with a parse error and batches with invalid request', async () => {
    const { server } = createServer();
    const responses = await exchange(server, ['{not json', '[]']);
    assert.deepEqual(responses, [
      { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.parse, message: 'Parse error' } },
      { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.invalidRequest, message: 'Batch requests are not supported' } },
    ]);
  });

  it('aborts a cancelled request and sends nothing for it', async () => {
    let observedSignal: AbortSignal | undefined;
    const slow = echoTool({
      handler: (_args, { signal }) => {
        observedSignal = signal;
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve('too late')));
      },
    });
    const { server } = createServer([slow]);
    const responses = await exchange(server, [
      JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }),
      JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'ping' }),
    ]);
    assert.equal(observedSignal?.aborted, true);
    assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 10, result: {} }]);
  });
});
