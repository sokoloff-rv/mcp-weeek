import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProjectConfig, type LoadedConfig } from '../src/config/project.ts';
import { Resolver } from '../src/resolve.ts';
import { WeeekApi } from '../src/weeek/api.ts';
import { WeeekClient } from '../src/weeek/client.ts';
import { Directory } from '../src/weeek/directory.ts';
import { BASE_URL, FakeFetch } from './helpers/fake-fetch.ts';
import { ALPHA_CONFIG, ANNA, BOARDS, COLUMNS, IVAN, ME, PROJECTS, TAGS } from './helpers/harness.ts';
import { captureLogger } from './helpers/log.ts';

function okConfig(config: object = ALPHA_CONFIG): LoadedConfig {
  return { status: 'ok', path: '/p/.weeek.json', dir: '/p', ...parseProjectConfig(JSON.stringify(config), '/p', '/h') };
}

function setup(loaded: LoadedConfig = okConfig()) {
  const fake = new FakeFetch()
    .fallback('GET', '/user/me', { user: ME })
    .fallback('GET', '/ws/members', { members: [ME, ANNA, IVAN] })
    .fallback('GET', '/ws/tags', { tags: TAGS })
    .fallback('GET', '/tm/projects', { projects: PROJECTS })
    .fallback('GET', '/tm/boards', (request) => ({ boards: BOARDS[Number(request.query.get('projectId'))] ?? [] }))
    .fallback('GET', '/tm/board-columns', (request) => ({ boardColumns: COLUMNS[Number(request.query.get('boardId'))] ?? [] }));
  const api = new WeeekApi(new WeeekClient({ token: 't', baseUrl: BASE_URL, log: captureLogger(), fetch: fake.fetch }));
  return { fake, resolver: new Resolver(new Directory(api), loaded) };
}

describe('Resolver: boards', () => {
  it('uses the first configured board by default', async () => {
    const { resolver } = setup();
    assert.equal((await resolver.board()).id, 11);
  });

  it('finds a board by id, alias and name', async () => {
    const { resolver } = setup();
    assert.equal((await resolver.board(12)).name, 'Идеи');
    assert.equal((await resolver.board('12')).name, 'Идеи');
    assert.equal((await resolver.board('MAIN')).id, 11);
    assert.equal((await resolver.board(' идеи ')).id, 12);
    assert.equal((await resolver.board('Main')).id, 11, 'alias wins over a board name in another project');
    assert.equal((await resolver.board(21)).projectId, 20);
  });

  it('takes the only board of the configured project when boards are not listed', async () => {
    const { resolver } = setup(okConfig({ projectId: 20 }));
    assert.equal((await resolver.board()).id, 21);
    await assert.rejects(setup(okConfig({ projectId: 10 })).resolver.board(), /lists no "boards".*Задачи \(11\), Идеи \(12\)/);
  });

  it('explains why there is no default board', async () => {
    await assert.rejects(setup({ status: 'missing', searchedFrom: '/work' }).resolver.board(), /no \.weeek\.json found \(searched from \/work upwards\)/);
    await assert.rejects(setup({ status: 'invalid', path: '/p/.weeek.json', error: 'not valid JSON' }).resolver.board(), /\/p\/\.weeek\.json is invalid: not valid JSON/);
  });

  it('still resolves explicit boards without a config', async () => {
    const { resolver } = setup({ status: 'missing', searchedFrom: '/work' });
    assert.equal((await resolver.board('Main')).id, 21);
  });

  it('reports an unknown board', async () => {
    const { resolver } = setup();
    await assert.rejects(resolver.board('Nope'), /Board "Nope" not found/);
  });
});

describe('Resolver: columns', () => {
  const board = { id: 11, name: 'Задачи', projectId: 10 };

  it('finds a column by alias, name and id', async () => {
    const { resolver } = setup();
    assert.equal((await resolver.column(board, 'testing')).id, 103);
    assert.equal((await resolver.column(board, 'в процессе')).id, 102);
    assert.equal((await resolver.column(board, 104)).name, 'Завершено');
    assert.equal((await resolver.column(board, 'done')).id, 104, 'alias pointing to an id');
  });

  it('lists the columns with aliases when nothing matches', async () => {
    const { resolver } = setup();
    await assert.rejects(
      resolver.column(board, 'review'),
      /Column "review" not found on board "Задачи" \(11\)\. Columns: На очереди \(101\) \[queue\], В процессе \(102\) \[in_progress\], Тестирование \(103\) \[testing\], Завершено \(104\) \[done\]\./,
    );
  });

  it('rereads columns once before giving up', async () => {
    const { resolver, fake } = setup();
    await resolver.columns(board);
    fake.on('GET', '/tm/board-columns', { boardColumns: [...(COLUMNS[11] ?? []), { id: 105, name: 'Review', boardId: 11 }] });
    assert.equal((await resolver.column(board, 'Review')).id, 105);
  });

  it('uses defaultColumn and falls back to the first column on other boards', async () => {
    const { resolver } = setup(okConfig({ ...ALPHA_CONFIG, defaultColumn: 'testing' }));
    assert.equal((await resolver.defaultColumn(board)).id, 103);
    assert.equal((await resolver.defaultColumn({ id: 21, name: 'Main', projectId: 20 })).id, 211);
  });

  it('applies name aliases on any board with the same column names', async () => {
    const { resolver } = setup(okConfig({ ...ALPHA_CONFIG, columns: { inbox: 'Входящие' } }));
    assert.equal((await resolver.column({ id: 12, name: 'Идеи', projectId: 10 }, 'inbox')).id, 121);
  });
});

describe('Resolver: people, projects and tags', () => {
  it('finds members by "me", id, email and names', async () => {
    const { resolver } = setup();
    assert.equal((await resolver.member('me')).id, ME.id);
    assert.equal((await resolver.member('7')).id, '7');
    assert.equal((await resolver.member('IVAN@example.com')).id, '8');
    assert.equal((await resolver.member('Анна')).id, '7');
    assert.equal((await resolver.member('петрова анна')).id, '7');
    await assert.rejects(resolver.member('Пётр'), /Member "Пётр" not found\. Members: Agent \(agent-1\), Анна Петрова \(7\), Иван Сидоров \(8\)/);
  });

  it('finds projects by id and title and defaults to the configured one', async () => {
    const { resolver } = setup();
    assert.equal((await resolver.project()).id, 10);
    assert.equal((await resolver.project('beta')).id, 20);
    await assert.rejects(resolver.project(99), /Project "99" not found\. Projects: Alpha \(10\), Beta \(20\)/);
  });

  it('resolves tags and refuses ambiguous or unknown ones', async () => {
    const { resolver } = setup();
    assert.deepEqual((await resolver.tags(['BUG', 2])).map((tag) => tag.id), [1, 2]);
    await assert.rejects(resolver.tags(['дубль']), /ambiguous: дубль \(3\), дубль \(4\)/);
    await assert.rejects(resolver.tags(['urgent']), /Tag "urgent" not found\. Existing tags: bug, feature, дубль, дубль\. This server does not create tags/);
  });
});
