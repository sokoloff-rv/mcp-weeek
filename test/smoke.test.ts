import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StdioClient } from '../scripts/mcp-client.ts';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const ALL_TOOLS = [
  'weeek_context',
  'weeek_list_tasks',
  'weeek_get_task',
  'weeek_create_task',
  'weeek_update_task',
  'weeek_move_task',
  'weeek_add_comment',
  'weeek_delete_comment',
  'weeek_attach_files',
  'weeek_get_attachment',
  'weeek_time_report',
];

async function start(env: Record<string, string>) {
  const cwd = await mkdtemp(join(tmpdir(), 'mcp-weeek-smoke-'));
  after(() => rm(cwd, { recursive: true, force: true }));
  const { WEEEK_TOKEN: _token, WEEEK_READ_ONLY: _readOnly, WEEEK_CONFIG: _config, ...rest } = process.env;
  return new StdioClient(process.execPath, [ENTRY], { cwd, env: { ...rest, ...env } });
}

describe('server process', () => {
  it('speaks MCP over stdio and lists all tools', async () => {
    const client = await start({ WEEEK_TOKEN: 'smoke-token-0123456789' });
    const init = await client.initialize();
    assert.equal(init.protocolVersion, '2025-11-25');
    assert.deepEqual(init.serverInfo, { name: 'mcp-weeek', version: '0.1.0' });
    const discover = await client.request('server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    });
    assert.equal(discover.resultType, 'complete');
    const { tools } = await client.request('tools/list');
    assert.deepEqual((tools as { name: string }[]).map((tool) => tool.name), ALL_TOOLS);
    for (const tool of tools as { description: string; inputSchema: { type: string } }[]) {
      assert.ok(tool.description.length > 40);
      assert.equal(tool.inputSchema.type, 'object');
    }
    assert.equal(await client.close(), 0);
    assert.ok(client.stderr.join('').includes('started in'));
    assert.ok(!client.stderr.join('').includes('smoke-token-0123456789'));
  });

  it('keeps only read tools in read-only mode', async () => {
    const client = await start({ WEEEK_TOKEN: 'smoke-token-0123456789', WEEEK_READ_ONLY: '1' });
    await client.initialize();
    const { tools } = await client.request('tools/list');
    assert.deepEqual(
      (tools as { name: string }[]).map((tool) => tool.name),
      ['weeek_context', 'weeek_list_tasks', 'weeek_get_task', 'weeek_get_attachment', 'weeek_time_report'],
    );
    await client.close();
  });

  it('starts without a token and explains the problem in tool results', async () => {
    const client = await start({});
    await client.initialize();
    const result = await client.callTool('weeek_context');
    assert.equal(result.isError, true);
    assert.match(result.text, /WEEEK_TOKEN is not set/);
    await client.close();
    assert.match(client.stderr.join(''), /error: WEEEK_TOKEN is not set/);
  });
});
