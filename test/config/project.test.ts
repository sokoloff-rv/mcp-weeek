import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseProjectConfig, ProjectConfigLoader } from '../../src/config/project.ts';

const DIR = '/home/user/project';
const HOME = '/home/user';

describe('parseProjectConfig', () => {
  it('reads a full config', () => {
    const { config, warnings } = parseProjectConfig(
      JSON.stringify({
        workspaceId: 1,
        projectId: 2,
        boards: [{ id: 3, alias: ' main ' }, 4],
        columns: { queue: ' На очереди ', done: 7 },
        defaultColumn: 'queue',
        attachRoots: ['.', 'shots', '~/Pictures', '/srv/files'],
        conventions: ['One', 'Two'],
      }),
      DIR,
      HOME,
    );
    assert.deepEqual(config, {
      workspaceId: 1,
      projectId: 2,
      boards: [
        { id: 3, alias: 'main' },
        { id: 4, alias: undefined },
      ],
      columns: { queue: 'На очереди', done: 7 },
      defaultColumn: 'queue',
      attachRoots: [DIR, `${DIR}/shots`, `${HOME}/Pictures`, '/srv/files'],
      conventions: ['One', 'Two'],
    });
    assert.deepEqual(warnings, []);
  });

  it('defaults attachRoots to the config folder and accepts a single convention string', () => {
    const { config } = parseProjectConfig('{"conventions": "Only one"}', DIR, HOME);
    assert.deepEqual(config.attachRoots, [DIR]);
    assert.deepEqual(config.conventions, ['Only one']);
    assert.deepEqual(config.boards, []);
  });

  it('warns about unknown keys instead of failing', () => {
    const { warnings } = parseProjectConfig('{"attachRoot": ".", "projectId": 5}', DIR, HOME);
    assert.deepEqual(warnings, ['Unknown key "attachRoot" is ignored.']);
  });

  it('collects all type errors in one message', () => {
    assert.throws(
      () => parseProjectConfig('{"projectId": "x", "boards": [{"alias": "a"}], "columns": {"q": false}, "conventions": [1]}', DIR, HOME),
      {
        message:
          '"boards[0]" must be a board id or {"id": number, "alias"?: string}; "columns.q" must be a column name or id; "conventions" must be a string or an array of strings; "projectId" must be a positive integer',
      },
    );
  });

  it('explains broken JSON', () => {
    assert.throws(() => parseProjectConfig('{"projectId": 1,', DIR, HOME), /not valid JSON/);
    assert.throws(() => parseProjectConfig('[1]', DIR, HOME), /must contain a JSON object/);
  });
});

describe('ProjectConfigLoader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-weeek-config-'));
  after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const nested = join(project, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const configPath = join(project, '.weeek.json');

  it('finds .weeek.json in a parent folder', async () => {
    await writeFile(configPath, '{"projectId": 1}');
    const loaded = await new ProjectConfigLoader({ cwd: () => nested, explicitPath: undefined, homeDir: root }).load();
    assert.equal(loaded.status, 'ok');
    assert.equal(loaded.status === 'ok' && loaded.path, configPath);
    assert.equal(loaded.status === 'ok' && loaded.config.projectId, 1);
  });

  it('reports a missing file with the search start', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mcp-weeek-empty-'));
    after(() => rm(empty, { recursive: true, force: true }));
    const loaded = await new ProjectConfigLoader({ cwd: () => empty, explicitPath: undefined, homeDir: root }).load();
    assert.deepEqual(loaded, { status: 'missing', searchedFrom: empty });
  });

  it('uses WEEEK_CONFIG when given and reports a missing explicit file', async () => {
    const other = join(root, 'other.json');
    await writeFile(other, '{"projectId": 9}');
    const explicit = await new ProjectConfigLoader({ cwd: () => nested, explicitPath: other, homeDir: root }).load();
    assert.equal(explicit.status === 'ok' && explicit.config.projectId, 9);
    const missing = await new ProjectConfigLoader({ cwd: () => nested, explicitPath: join(root, 'nope.json'), homeDir: root }).load();
    assert.equal(missing.status, 'invalid');
  });

  it('re-reads the file after it changes', async () => {
    const loader = new ProjectConfigLoader({ cwd: () => project, explicitPath: undefined, homeDir: root });
    await writeFile(configPath, '{"projectId": 1}');
    await utimes(configPath, new Date('2026-01-01'), new Date('2026-01-01'));
    assert.equal(((await loader.load()) as { config: { projectId: number } }).config.projectId, 1);
    await writeFile(configPath, '{"projectId": 22}');
    await utimes(configPath, new Date('2026-01-02'), new Date('2026-01-02'));
    assert.equal(((await loader.load()) as { config: { projectId: number } }).config.projectId, 22);
    await writeFile(configPath, '{oops');
    await utimes(configPath, new Date('2026-01-03'), new Date('2026-01-03'));
    const broken = await loader.load();
    assert.equal(broken.status, 'invalid');
    assert.match(broken.status === 'invalid' ? broken.error : '', /not valid JSON/);
  });
});
