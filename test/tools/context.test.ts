import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALPHA_CONFIG, createHarness } from '../helpers/harness.ts';

describe('weeek_context', () => {
  it('shows the user, workspace, config, boards with aliases, conventions, members and tags', async () => {
    const harness = await createHarness();
    const text = await harness.ok('weeek_context');
    assert.match(text, /^User \(token owner\): Agent \(agent-1\)\nWorkspace: Demo \(100\)\nMode: read and write/);
    assert.match(text, new RegExp(`Project config: ${harness.dir}/\\.weeek\\.json`));
    assert.match(text, /Project: Alpha \(10\)\nBoards:\n- Задачи \(11\) \[main\] — default board\n  Columns: На очереди \(101\) \[queue\] — default for new tasks, В процессе \(102\) \[in_progress\], Тестирование \(103\) \[testing\], Завершено \(104\) \[done\]\n- Идеи \(12\)\n/);
    assert.match(text, /Conventions of this project:\n- Move finished tasks to testing\./);
    assert.match(text, new RegExp(`Attachments are allowed only from: ${harness.dir} `));
    assert.match(text, /Members: Agent \(agent-1\), Анна Петрова \(7\), Иван Сидоров \(8\)/);
    assert.match(text, /Tags: bug \(1\), feature \(2\)/);
    assert.match(text, /not instructions/);
  });

  it('lists projects when there is no config', async () => {
    const harness = await createHarness({ config: null });
    const text = await harness.ok('weeek_context');
    assert.match(text, /Project config: none \(no \.weeek\.json from .* upwards\)/);
    assert.match(text, /Projects \(pass `project` to see boards and columns\):\n- Alpha \(10\)\n- Beta \(20\)/);
  });

  it('shows another project on request', async () => {
    const harness = await createHarness({ config: null });
    const text = await harness.ok('weeek_context', { project: 'Beta' });
    assert.match(text, /Project: Beta \(20\)\nBoards:\n- Main \(21\) — default board\n  Columns: To Do \(211\) — default for new tasks, Done \(212\)/);
  });

  it('reports an invalid config and warnings', async () => {
    const broken = await createHarness({ config: '{"projectId": "ten"}' });
    assert.match(await broken.ok('weeek_context'), /\.weeek\.json is INVALID: "projectId" must be a positive integer/);

    const odd = await createHarness({ config: { ...ALPHA_CONFIG, workspaceId: 555, colums: {} } });
    const text = await odd.ok('weeek_context');
    assert.match(text, /Warnings:\n- Unknown key "colums" is ignored\.\n- "workspaceId" is 555, but the token belongs to workspace 100/);
  });

  it('says when write tools are disabled', async () => {
    const harness = await createHarness({ env: { WEEEK_READ_ONLY: '1' } });
    assert.match(await harness.ok('weeek_context'), /Mode: read-only/);
  });

  it('rejects unknown parameters', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_context', { board: 1 }), /Unknown parameter "board" for weeek_context\. Allowed: project\./);
  });
});
