/**
 * Живая проверка сервера на настоящем Weeek. Запускается только явно и только на тестовом проекте:
 *
 *   WEEEK_TOKEN=… WEEEK_TEST_PROJECT=<id> WEEEK_TEST_BOARD=<id> [WEEEK_TEST_BOARD_2=<id>] npm run live
 *
 * Создаёт задачи с префиксом [mcp-test], проходит все инструменты через настоящий процесс сервера,
 * а в конце удаляет созданные задачи напрямую через API.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../src/config/env.ts';
import { createLogger } from '../src/log.ts';
import { WeeekApi } from '../src/weeek/api.ts';
import { WeeekClient } from '../src/weeek/client.ts';
import { StdioClient, type ToolCallResult } from './mcp-client.ts';

const env = readEnv();
const projectId = Number(process.env.WEEEK_TEST_PROJECT);
const boardId = Number(process.env.WEEEK_TEST_BOARD);
const secondBoardId = Number(process.env.WEEEK_TEST_BOARD_2) || undefined;
if (env.problems.length > 0 || !projectId || !boardId) {
  console.error([...env.problems, 'Set WEEEK_TEST_PROJECT and WEEEK_TEST_BOARD to a test project and its board.'].join('\n'));
  process.exit(2);
}

const log = createLogger({ secrets: [env.token], debug: false });
const client = new WeeekClient({ token: env.token, baseUrl: env.baseUrl, log });
const api = new WeeekApi(client);
const columns = await api.columns(boardId);
if (columns.length < 2) throw new Error('The test board needs at least two columns.');
const [first, second] = columns as [(typeof columns)[number], (typeof columns)[number]];

const dir = await mkdtemp(join(tmpdir(), 'mcp-weeek-live-'));
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da63f8ffff3f0005fe02fea7d6a4c40000000049454e44ae426082', 'hex');
await writeFile(join(dir, 'shot.png'), png);
await writeFile(join(dir, 'notes.md'), '# Notes\n');
await writeFile(join(dir, '.env'), 'SECRET=1\n');
await writeFile(
  join(dir, '.weeek.json'),
  JSON.stringify({
    projectId,
    boards: [{ id: boardId, alias: 'main' }],
    columns: { first: first.name, second: second.name },
    defaultColumn: 'first',
    conventions: ['Live check of mcp-weeek.'],
  }),
);

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const { WEEEK_CONFIG: _config, WEEEK_READ_ONLY: _readOnly, ...childEnv } = process.env;
const server = new StdioClient(process.execPath, [entry], { cwd: dir, env: childEnv });
const created: number[] = [];
const results: { name: string; ok: boolean; detail?: string }[] = [];
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(ok || detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n     ${detail.replace(/\n/g, '\n     ')}`}`);
}

async function call(tool: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const result = await server.callTool(tool, args);
  if (result.isError) console.log(`     ${tool} → error: ${result.text}`);
  return result;
}

function createdId(result: ToolCallResult): number {
  const id = Number(/Created task #(\d+)/.exec(result.text)?.[1]);
  if (id) created.push(id);
  return id;
}

try {
  await server.initialize();
  const { tools } = await server.request('tools/list');
  check('tools/list has 11 tools', (tools as unknown[]).length === 11);

  const context = await call('weeek_context');
  check('weeek_context shows the board and its aliases', !context.isError && context.text.includes(`(${boardId}) [main]`) && context.text.includes('[first]'), context.text);

  const title = `[mcp-test] live ${stamp}`;
  const create = await call('weeek_create_task', {
    title,
    description: '**Live** check\n\n- item\n  - nested',
    priority: 'medium',
    assignees: ['me'],
    startDate: '2030-01-01',
    dueDate: '2030-01-02',
    attachments: ['shot.png'],
  });
  const taskId = createdId(create);
  check('weeek_create_task creates in the default column with a file', Boolean(taskId) && create.text.includes(`[first]`) && create.text.includes('Attached: shot.png'), create.text);

  const card = await call('weeek_get_task', { id: taskId });
  check(
    'weeek_get_task shows Markdown, dates, assignee and the file',
    card.text.includes('**Live** check') && card.text.includes('  - nested') && card.text.includes('start 2030-01-01, due 2030-01-02') && card.text.includes('shot.png'),
    card.text,
  );

  const list = await call('weeek_list_tasks', { column: 'first' });
  check('weeek_list_tasks lists the task in its column', list.text.includes(`#${taskId} ${title}`), list.text);

  const update = await call('weeek_update_task', { id: taskId, title: `${title} (updated)`, priority: 'low', dueDate: '2030-01-05', completed: true });
  const updated = await call('weeek_get_task', { id: taskId });
  check(
    'weeek_update_task changes title, priority, due date and completion',
    !update.isError && updated.text.includes('(updated)') && updated.text.includes('Priority: low') && updated.text.includes('start 2030-01-01, due 2030-01-05') && updated.text.includes('Status: completed'),
    updated.text,
  );
  await call('weeek_update_task', { id: taskId, completed: false });

  const description = await call('weeek_update_task', { id: taskId, description: 'new' });
  check('weeek_update_task refuses to change the description', description.isError && description.text.includes('weeek_add_comment'));

  const move = await call('weeek_move_task', { id: taskId, column: 'second' });
  check('weeek_move_task moves by alias', !move.isError && move.text.includes('[second]'), move.text);
  if (secondBoardId) {
    const away = await call('weeek_move_task', { id: taskId, board: secondBoardId });
    const back = await call('weeek_move_task', { id: taskId, board: 'main', column: 'first' });
    check('weeek_move_task moves between boards', !away.isError && !back.isError && back.text.includes('[first]'), `${away.text}\n${back.text}`);
  }

  const subtask = await call('weeek_create_task', { title: `[mcp-test] subtask ${stamp}`, parent: taskId });
  const subtaskId = createdId(subtask);
  const parentCard = await call('weeek_get_task', { id: taskId });
  check('a subtask appears in the parent card', Boolean(subtaskId) && parentCard.text.includes(`#${subtaskId} [mcp-test] subtask`), parentCard.text);

  const comment = await call('weeek_add_comment', { id: taskId, text: 'Result:\n\n- done\n  - nested detail' });
  const commentId = Number(/Comment #(\d+)/.exec(comment.text)?.[1]);
  const withComment = await call('weeek_get_task', { id: taskId });
  check('weeek_add_comment posts a flattened nested list', Boolean(commentId) && withComment.text.includes('◦ nested detail'), withComment.text);
  const deleted = await call('weeek_delete_comment', { id: taskId, commentId });
  const withoutComment = await call('weeek_get_task', { id: taskId });
  check('weeek_delete_comment removes own comment', !deleted.isError && !withoutComment.text.includes(`Comment #${commentId} `), withoutComment.text);

  const attach = await call('weeek_attach_files', { id: taskId, paths: ['notes.md'] });
  check('weeek_attach_files uploads an allowed file', !attach.isError && attach.text.includes('notes.md'), attach.text);
  const hidden = await call('weeek_attach_files', { id: taskId, paths: ['.env'] });
  const outside = await call('weeek_attach_files', { id: taskId, paths: ['/etc/hostname'] });
  check('weeek_attach_files refuses hidden and outside files', hidden.isError && outside.isError);

  const attachmentId = /shot\.png · [^·]+ · id (\S+)/.exec(withoutComment.text)?.[1];
  const download = await call('weeek_get_attachment', { id: attachmentId });
  const savedPath = /to (.+)$/.exec(download.text)?.[1];
  const saved = savedPath ? await readFile(savedPath) : undefined;
  check('weeek_get_attachment downloads the same bytes', Boolean(saved?.equals(png)), download.text);
  if (savedPath) await rm(join(savedPath, '..'), { recursive: true, force: true });

  const report = await call('weeek_time_report', { period: 'today' });
  check('weeek_time_report answers', !report.isError && report.text.startsWith('Time report'), report.text);
} finally {
  for (const id of created.reverse()) {
    await client.delete(`/tm/tasks/${id}`).then(
      () => console.log(`cleanup: deleted task #${id}`),
      (error: unknown) => console.log(`cleanup: could not delete #${id}: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  await server.close();
  await rm(dir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length > 0 ? 1 : 0);
