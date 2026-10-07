import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { json } from '../helpers/fake-fetch.ts';
import { ANNA, createHarness, IVAN, ME, task } from '../helpers/harness.ts';

describe('weeek_list_tasks', () => {
  it('groups tasks by columns of the default board and nests subtasks', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks', {
      tasks: [
        task({ id: 1, title: 'Первая', boardColumnId: 101, priority: 2, dueDate: '2026-10-20', assignees: ['7'], tags: [1], subTasks: [3, 5] }),
        task({ id: 2, title: 'Вторая', boardColumnId: 103, attachments: [{ id: 'a', name: 'x.png', size: 1, url: '', createdAt: '', creatorId: null }] }),
        task({ id: 3, title: 'Подзадача', boardColumnId: 101, parentId: 1 }),
        task({ id: 4, title: 'Удалённая', isDeleted: true }),
      ],
      hasMore: false,
    });
    const text = await harness.ok('weeek_list_tasks');
    assert.equal(
      text,
      [
        'Board Задачи (11) [main]: 3 tasks, completed hidden.',
        '',
        '## На очереди (101) [queue] — 1',
        '- #1 Первая · high · due 2026-10-20 · @Анна Петрова · #bug · subtasks: 2 (1 not listed here)',
        '  - #3 Подзадача',
        '',
        '## В процессе (102) [in_progress] — 0',
        '',
        '## Тестирование (103) [testing] — 1',
        '- #2 Вторая · 1 file',
        '',
        '## Завершено (104) [done] — 0',
      ].join('\n'),
    );
    const [call] = harness.fake.callsTo('GET', '/tm/tasks');
    assert.equal(call?.url.search, '?projectId=10&boardId=11&completed=0&perPage=100&offset=0');
  });

  it('pages through all tasks', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks', { tasks: [task({ id: 1 })], hasMore: true }, { times: 1 })
      .on('GET', '/tm/tasks', { tasks: [task({ id: 2 })], hasMore: false });
    assert.match(await harness.ok('weeek_list_tasks'), /2 tasks/);
    assert.deepEqual(harness.fake.callsTo('GET', '/tm/tasks').map((call) => call.query.get('offset')), ['0', '100']);
  });

  it('filters by column, search, assignee, tag and completion', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks', {
      tasks: [task({ id: 1, assignees: ['8'], tags: [2] }), task({ id: 2, assignees: ['8'] }), task({ id: 3, tags: [2] })],
      hasMore: false,
    });
    const text = await harness.ok('weeek_list_tasks', { column: 'queue', search: 'логин', assignee: 'Иван', tag: 'feature', completed: 'include' });
    assert.match(text, /^Board Задачи \(11\) \[main\]: 1 task\.\n\n## На очереди \(101\) \[queue\] — 1\n- #1 Задача · @Иван Сидоров · #feature$/);
    const [call] = harness.fake.callsTo('GET', '/tm/tasks');
    assert.equal(call?.query.get('boardColumnId'), '101');
    assert.equal(call?.query.get('search'), 'логин');
    assert.equal(call?.query.has('completed'), false);
  });

  it('explains an unknown column', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_list_tasks', { column: 'review' }), /Column "review" not found on board "Задачи"/);
  });
});

describe('weeek_get_task', () => {
  it('renders the full card', async () => {
    const harness = await createHarness();
    harness.fake
      .on(
        'GET',
        '/tm/tasks/500',
        {
          task: task({
            priority: 1,
            startDate: '2026-10-09',
            dueDate: '2026-10-12',
            duration: 90,
            assignees: ['7'],
            tags: [1, 2],
            parentId: 400,
            subTasks: [501],
            description: '<p>Сделать <strong>вход</strong></p><ul><li><p>шаг</p></li></ul>',
            attachments: [{ id: 'f-1', name: 'shot.png', size: 2048, url: '', createdAt: '', creatorId: ME.id }],
            timeEntries: [
              { id: 't1', userId: '7', type: 2, isOvertime: false, date: '2026-10-08', duration: 95, durationSeconds: 5700, comment: null },
              { id: 't2', userId: '8', type: 1, isOvertime: false, date: '2026-10-09', duration: 0, durationSeconds: 1800, comment: null },
            ],
          }),
        },
      )
      .on('GET', '/tm/tasks/400', { task: task({ id: 400, title: 'Родитель' }) })
      .on('GET', '/tm/tasks/501', { task: task({ id: 501, title: 'Шаг 1', isCompleted: true }) })
      .on('GET', '/tm/tasks/500/comments', {
        comments: [
          { id: 2, parentId: 1, authorId: '8', markdown: 'Ответ', createdAt: '2026-10-08T11:00:00Z', updatedAt: '' },
          { id: 1, parentId: null, authorId: '7', markdown: '__Вопрос__', createdAt: '2026-10-08T10:00:00Z', updatedAt: '' },
        ],
        hasMore: false,
      });
    const text = await harness.ok('weeek_get_task', { id: 500 });
    assert.equal(
      text,
      [
        '# #500 Задача',
        'Where: Задачи / На очереди [queue] (project 10)',
        'Status: open',
        'Priority: medium',
        'Dates: start 2026-10-09, due 2026-10-12',
        'Estimate: 1 h 30 min',
        'Assignees: Анна Петрова',
        'Tags: bug, feature',
        'Parent: #400 Родитель',
        'Created 2026-10-01 10:00 UTC by Agent; updated 2026-10-01 10:00 UTC',
        'Link: https://app.weeek.net/ws/100/project/10/board/11?modals=m_task&m_task_workspace-id=100&m_task_id=500',
        '',
        '## Subtasks (1)',
        '- #501 Шаг 1 · completed',
        '',
        '## Description',
        'Сделать **вход**',
        '',
        '- шаг',
        '',
        '## Attachments (1)',
        '- shot.png · 2 KB · id f-1',
        '',
        '## Time: 2 h 5 min',
        '- 2026-10-08 · Анна Петрова · 1 h 35 min',
        '- 2026-10-09 · Иван Сидоров · 30 min (timer)',
        '',
        '## Comments (2, oldest first)',
        '',
        '### Comment #1 · Анна Петрова · 2026-10-08 10:00 UTC',
        '__Вопрос__',
        '',
        '### Comment #2 · Иван Сидоров · 2026-10-08 11:00 UTC · reply to #1',
        'Ответ',
      ].join('\n'),
    );
  });

  it('reports a missing task', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/9', () => json({ success: false, code: 1000001, message: 'Model not found' }, 400));
    assert.match(await harness.fail('weeek_get_task', { id: 9 }), /Not found \(400: Model not found\)\. Check the id/);
  });

  it('requires an id', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_get_task'), /Parameter "id" is required/);
  });
});

describe('weeek_create_task', () => {
  it('creates a task in the default column with an HTML description', async () => {
    const harness = await createHarness();
    harness.fake.on('POST', '/tm/tasks', (request) => ({ task: task({ id: 777, title: (request.body as { title: string }).title }) }));
    const text = await harness.ok('weeek_create_task', { title: ' Новая задача ', description: 'Текст **важный**\n\n- пункт', priority: 'high' });
    assert.equal(
      text,
      'Created task #777 "Новая задача" in Задачи / На очереди [queue].\nLink: https://app.weeek.net/ws/100/project/10/board/11?modals=m_task&m_task_workspace-id=100&m_task_id=777',
    );
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks')[0]?.body, {
      title: 'Новая задача',
      description: '<p>Текст <strong>важный</strong></p><ul><li><p>пункт</p></li></ul>',
      priority: 2,
      locations: [{ projectId: 10, boardId: 11, boardColumnId: 101 }],
    });
    assert.equal(harness.fake.callsTo('PUT', /^\/tm\/tasks\//).length, 0);
  });

  it('sets dates, tags and assignees after creation', async () => {
    const harness = await createHarness();
    harness.fake
      .on('POST', '/tm/tasks', { task: task({ id: 777 }) })
      .on('PUT', '/tm/tasks/777', { task: task({ id: 777 }) })
      .on('POST', '/tm/tasks/777/assignees', { success: true });
    await harness.ok('weeek_create_task', {
      title: 'A',
      column: 'testing',
      tags: ['bug'],
      assignees: ['me', 'anna@example.com'],
      startDate: '2026-10-09',
      dueDate: '2026-10-10',
    });
    assert.deepEqual((harness.fake.callsTo('POST', '/tm/tasks')[0]?.body as { locations: unknown }).locations, [{ projectId: 10, boardId: 11, boardColumnId: 103 }]);
    assert.deepEqual(harness.fake.callsTo('PUT', '/tm/tasks/777')[0]?.body, { startDate: '2026-10-09', dueDate: '2026-10-10', tags: [1] });
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/777/assignees')[0]?.body, { assignees: [ME.id, ANNA.id] });
  });

  it('creates a subtask in the parent project without a board', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500', { task: task({ id: 500, projectId: 20, boardId: 21, boardColumnId: 211 }) })
      .on('POST', '/tm/tasks', { task: task({ id: 778 }) });
    const text = await harness.ok('weeek_create_task', { title: 'Шаг', parent: 500 });
    assert.equal(text, 'Created task #778 "Задача" in project 20 as a subtask of #500.');
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks')[0]?.body, { title: 'Шаг', parentId: 500, locations: [{ projectId: 20 }] });
  });

  it('puts a subtask on the parent board when a column is given', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500', { task: task({ id: 500, projectId: 20, boardId: 21, boardColumnId: 211 }) })
      .on('POST', '/tm/tasks', { task: task({ id: 778 }) });
    assert.match(await harness.ok('weeek_create_task', { title: 'Шаг', parent: 500, column: 'Done' }), /in Main \/ Done, subtask of #500/);
    assert.deepEqual((harness.fake.callsTo('POST', '/tm/tasks')[0]?.body as { locations: unknown }).locations, [{ projectId: 20, boardId: 21, boardColumnId: 212 }]);
  });

  it('validates everything before creating anything', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_create_task', { title: '   ' }), /Parameter "title" is required/);
    assert.match(await harness.fail('weeek_create_task', { title: 'A', tags: ['urgent'] }), /Tag "urgent" not found/);
    assert.match(await harness.fail('weeek_create_task', { title: 'A', assignees: ['Пётр'] }), /Member "Пётр" not found/);
    assert.match(await harness.fail('weeek_create_task', { title: 'A', startDate: '2026-10-09' }), /needs a due date when a start date is set/);
    assert.match(await harness.fail('weeek_create_task', { title: 'A', dueDate: '2026-02-30' }), /must be YYYY-MM-DD/);
    assert.match(await harness.fail('weeek_create_task', { title: 'A', attachments: ['/etc/passwd'] }), /outside the allowed folders/);
    assert.match(await harness.fail('weeek_create_task', { title: 'A', priority: 'urgent' }), /must be one of: low, medium, high, hold/);
    assert.equal(harness.fake.callsTo('POST', '/tm/tasks').length, 0);
  });

  it('does not duplicate a task that Weeek created despite a 502', async () => {
    const harness = await createHarness();
    harness.fake
      .on('POST', '/tm/tasks', () => json({ message: 'Bad Gateway' }, 502))
      .on('GET', '/tm/tasks', {
        tasks: [
          task({ id: 10, title: 'Отчёт', createdAt: '2026-10-08T11:59:30Z' }),
          task({ id: 9, title: 'Отчёт', createdAt: '2026-09-01T10:00:00Z' }),
          task({ id: 11, title: 'Отчёт', authorId: '7', createdAt: '2026-10-08T12:00:00Z' }),
        ],
        hasMore: false,
      });
    const text = await harness.ok('weeek_create_task', { title: 'Отчёт' });
    assert.match(text, /^Created task #10 "Отчёт"/);
    assert.match(text, /the task had been created: no duplicate was made/);
    assert.equal(harness.fake.callsTo('POST', '/tm/tasks').length, 1);
    assert.equal(harness.fake.callsTo('GET', '/tm/tasks')[0]?.query.get('search'), 'Отчёт');
  });

  it('says that retrying is safe when the task really was not created', async () => {
    const harness = await createHarness();
    harness.fake
      .on('POST', '/tm/tasks', () => json({}, 503))
      .on('GET', '/tm/tasks', { tasks: [task({ id: 9, title: 'Отчёт', createdAt: '2026-09-01T10:00:00Z' })], hasMore: false });
    assert.match(await harness.fail('weeek_create_task', { title: 'Отчёт' }), /server error \(503\).*The task was not created: checked the project for "Отчёт"\. It is safe to retry\./);
    assert.equal(harness.fake.callsTo('POST', '/tm/tasks').length, 1);
  });

  it('reports follow-up steps that failed without hiding the created task', async () => {
    const harness = await createHarness({ files: { 'shot.png': 'png' } });
    harness.fake
      .on('POST', '/tm/tasks', { task: task({ id: 777 }) })
      .on('POST', '/tm/tasks/777/attachments', () => json({ success: false, errors: { files: ['Too large.'] } }, 422));
    const text = await harness.ok('weeek_create_task', { title: 'A', attachments: ['shot.png'] });
    assert.match(text, /^Created task #777/);
    assert.match(text, /Not done \(the task exists; fix with weeek_update_task or weeek_attach_files\): attachments: Weeek rejected the request \(422\): files: Too large\./);
  });
});

describe('weeek_update_task', () => {
  it('refuses to change the description with an explanation', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_update_task', { id: 500, description: 'x' }), /cannot change the description.*weeek_add_comment/);
  });

  it('needs something to change', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_update_task', { id: 500 }), /Nothing to update/);
  });

  it('applies fields, tags, completion, parent and assignees', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500', { task: task({ tags: [1, 3], dueDate: '2026-10-20' }) })
      .on('PUT', '/tm/tasks/500', { task: task() })
      .on('POST', '/tm/tasks/500/complete', { success: true })
      .on('POST', '/tm/tasks/500/parent', { success: true })
      .on('POST', '/tm/tasks/500/assignees', { success: true })
      .on('DELETE', '/tm/tasks/500/assignees', { success: true });
    const text = await harness.ok('weeek_update_task', {
      id: 500,
      title: 'Новое',
      priority: 'none',
      startDate: '2026-10-10',
      estimateMinutes: 0,
      completed: true,
      parent: 'none',
      addTags: ['feature'],
      removeTags: ['bug'],
      addAssignees: ['Иван Сидоров'],
      removeAssignees: ['me'],
    });
    assert.equal(
      text,
      'Updated #500 "Новое": title → "Новое", priority → none, start → 2026-10-10, estimate → none, tag + feature, tag − bug, completed, detached from its parent, assignee + Иван Сидоров, assignee − Agent.',
    );
    assert.deepEqual(harness.fake.callsTo('PUT', '/tm/tasks/500')[0]?.body, {
      startDate: '2026-10-10',
      dueDate: '2026-10-20',
      title: 'Новое',
      priority: null,
      duration: null,
      tags: [3, 2],
    });
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/500/parent')[0]?.body, { parentId: null });
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/500/assignees')[0]?.body, { assignees: [IVAN.id] });
    assert.deepEqual(harness.fake.callsTo('DELETE', '/tm/tasks/500/assignees')[0]?.body, { assignees: [ME.id] });
  });

  it('keeps the current due date-time when only the due date-time changes and clears dates on request', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500', { task: task({ startDateTime: '2026-10-09T07:00:00Z', dueDateTime: '2026-10-10T07:00:00Z' }) })
      .on('PUT', '/tm/tasks/500', { task: task() });
    await harness.ok('weeek_update_task', { id: 500, dueDate: '2026-10-11T18:30:00+03:00' });
    await harness.ok('weeek_update_task', { id: 500, dueDate: '' });
    assert.match(await harness.fail('weeek_update_task', { id: 500, dueDate: '2026-10-11' }), /same kind/);
    assert.deepEqual(
      harness.fake.callsTo('PUT', '/tm/tasks/500').map((call) => call.body),
      [
        { startDateTime: '2026-10-09T07:00:00Z', dueDateTime: '2026-10-11T15:30:00Z' },
        { startDate: null, dueDate: null, startDateTime: null, dueDateTime: null },
      ],
    );
  });

  it('does not touch completion when it already matches', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/500', { task: task({ isCompleted: true }) });
    assert.equal(await harness.ok('weeek_update_task', { id: 500, completed: true }), 'Updated #500 "Задача": no changes.');
    assert.equal(harness.fake.callsTo('POST', /complete/).length, 0);
  });
});

describe('weeek_move_task', () => {
  it('moves to a column of the current board by alias', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/500', { task: task() }).on('POST', '/tm/tasks/500/board-column', { success: true });
    assert.equal(
      await harness.ok('weeek_move_task', { id: 500, column: 'testing' }),
      'Moved #500 "Задача": Задачи / На очереди [queue] → Задачи / Тестирование [testing].',
    );
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/500/board-column')[0]?.body, { boardColumnId: 103 });
  });

  it('moves to another board and reports the landing column', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500', { task: task() })
      .on('POST', '/tm/tasks/500/board', { success: true, boardId: 12, boardColumnId: 121 });
    assert.equal(await harness.ok('weeek_move_task', { id: 500, board: 'Идеи' }), 'Moved #500 "Задача": Задачи / На очереди [queue] → Идеи / Входящие.');
  });

  it('moves straight to a column of another board', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/500', { task: task() }).on('POST', '/tm/tasks/500/board-column', { success: true });
    await harness.ok('weeek_move_task', { id: 500, board: 12, column: 'Готово' });
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/500/board-column')[0]?.body, { boardColumnId: 122 });
  });

  it('does nothing when the task is already there', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/500', { task: task() });
    assert.match(await harness.ok('weeek_move_task', { id: 500, column: 'queue' }), /already in Задачи \/ На очереди \[queue\]/);
    assert.equal(harness.fake.callsTo('POST', /board/).length, 0);
  });

  it('needs a column or a board', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_move_task', { id: 500 }), /Pass `column`, `board` or both/);
  });
});

describe('read-only mode', () => {
  it('hides write tools', async () => {
    const harness = await createHarness({ env: { WEEEK_READ_ONLY: '1' } });
    const response = await harness.server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (response?.result?.tools as { name: string }[]).map((tool) => tool.name);
    assert.ok(names.includes('weeek_get_task'));
    assert.ok(!names.includes('weeek_create_task'));
    assert.ok(!names.includes('weeek_move_task'));
    await assert.rejects(harness.call('weeek_create_task', { title: 'A' }), /Unknown tool: weeek_create_task/);
  });
});
