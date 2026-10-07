import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { createApp } from '../../src/app.ts';
import { readEnv } from '../../src/config/env.ts';
import type { McpServer } from '../../src/mcp/server.ts';
import type { Task } from '../../src/weeek/types.ts';
import { FakeFetch } from './fake-fetch.ts';
import { captureLogger, type CapturedLogger } from './log.ts';

export const TOKEN = 'harness-token-0123456789';

export const ME = { id: 'agent-1', firstName: 'Agent', lastName: null, email: 'agent@example.com' };
export const ANNA = { id: '7', firstName: 'Анна', lastName: 'Петрова', email: 'anna@example.com' };
export const IVAN = { id: '8', firstName: 'Иван', lastName: 'Сидоров', email: 'ivan@example.com' };

export const TAGS = [
  { id: 1, title: 'bug' },
  { id: 2, title: 'feature' },
  { id: 3, title: 'дубль' },
  { id: 4, title: 'дубль' },
];

export const PROJECTS = [
  { id: 10, title: 'Alpha' },
  { id: 20, title: 'Beta' },
];

export const BOARDS: Record<number, { id: number; name: string; projectId: number }[]> = {
  10: [
    { id: 11, name: 'Задачи', projectId: 10 },
    { id: 12, name: 'Идеи', projectId: 10 },
  ],
  20: [{ id: 21, name: 'Main', projectId: 20 }],
};

export const COLUMNS: Record<number, { id: number; name: string; boardId: number }[]> = {
  11: [
    { id: 101, name: 'На очереди', boardId: 11 },
    { id: 102, name: 'В процессе', boardId: 11 },
    { id: 103, name: 'Тестирование', boardId: 11 },
    { id: 104, name: 'Завершено', boardId: 11 },
  ],
  12: [
    { id: 121, name: 'Входящие', boardId: 12 },
    { id: 122, name: 'Готово', boardId: 12 },
  ],
  21: [
    { id: 211, name: 'To Do', boardId: 21 },
    { id: 212, name: 'Done', boardId: 21 },
  ],
};

export const ALPHA_CONFIG = {
  workspaceId: 100,
  projectId: 10,
  boards: [{ id: 11, alias: 'main' }],
  columns: { queue: 'На очереди', in_progress: 'В процессе', testing: 'Тестирование', done: 104 },
  defaultColumn: 'queue',
  conventions: ['Move finished tasks to testing.'],
};

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 500,
    parentId: null,
    title: 'Задача',
    description: '<p>Описание</p>',
    type: 'action',
    priority: null,
    isCompleted: false,
    isDeleted: false,
    completedAt: null,
    authorId: ME.id,
    userId: null,
    assignees: [],
    projectId: 10,
    boardId: 11,
    boardColumnId: 101,
    locations: [{ projectId: 10, boardId: 11, boardColumnId: 101 }],
    startDate: null,
    dueDate: null,
    startDateTime: null,
    dueDateTime: null,
    duration: null,
    tags: [],
    subTasks: [],
    attachments: [],
    timeEntries: [],
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    ...overrides,
  };
}

export type HarnessOptions = {
  config?: object | string | null;
  env?: Record<string, string>;
  files?: Record<string, string | Buffer>;
  now?: Date;
};

export type ToolOutput = { text: string; isError: boolean };

export type Harness = {
  dir: string;
  downloadDir: string;
  fake: FakeFetch;
  log: CapturedLogger;
  server: McpServer;
  call(tool: string, args?: Record<string, unknown>): Promise<ToolOutput>;
  ok(tool: string, args?: Record<string, unknown>): Promise<string>;
  fail(tool: string, args?: Record<string, unknown>): Promise<string>;
};

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-weeek-test-'));
  after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'project');
  const downloadDir = join(root, 'downloads');
  await mkdir(dir, { recursive: true });
  const config = options.config === undefined ? ALPHA_CONFIG : options.config;
  if (config !== null) {
    await writeFile(join(dir, '.weeek.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }

  const fake = new FakeFetch();
  registerWorkspace(fake);
  const log = captureLogger([TOKEN]);
  const now = options.now ?? new Date('2026-10-08T12:00:00Z');
  const server = createApp({
    env: readEnv({ WEEEK_TOKEN: TOKEN, ...options.env }),
    log,
    cwd: () => dir,
    homeDir: root,
    downloadDir,
    fetch: fake.fetch,
    now: () => now,
    retryDelayMs: 0,
  });

  let nextId = 1;
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<ToolOutput> => {
    const response = await server.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: tool, arguments: args } });
    if (response?.error) throw new Error(`JSON-RPC error ${response.error.code}: ${response.error.message}`);
    const content = (response?.result?.content ?? []) as { text: string }[];
    return { text: content.map((item) => item.text).join('\n'), isError: response?.result?.isError === true };
  };
  const ok = async (tool: string, args?: Record<string, unknown>) => {
    const output = await call(tool, args);
    if (output.isError) throw new Error(`${tool} failed: ${output.text}`);
    return output.text;
  };
  const fail = async (tool: string, args?: Record<string, unknown>) => {
    const output = await call(tool, args);
    if (!output.isError) throw new Error(`${tool} unexpectedly succeeded: ${output.text}`);
    return output.text;
  };
  return { dir, downloadDir, fake, log, server, call, ok, fail };
}

function registerWorkspace(fake: FakeFetch): void {
  fake
    .fallback('GET', '/user/me', { success: true, user: ME })
    .fallback('GET', '/ws', { success: true, workspace: { id: 100, title: 'Demo' } })
    .fallback('GET', '/ws/members', { success: true, members: [ME, ANNA, IVAN] })
    .fallback('GET', '/ws/tags', { success: true, tags: TAGS })
    .fallback('GET', '/tm/projects', { success: true, projects: PROJECTS })
    .fallback('GET', '/tm/boards', (request) => ({ success: true, boards: BOARDS[Number(request.query.get('projectId'))] ?? [] }))
    .fallback('GET', '/tm/board-columns', (request) => ({
      success: true,
      boardColumns: COLUMNS[Number(request.query.get('boardId'))] ?? [],
    }));
}
