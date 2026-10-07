import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveRange } from '../../src/tools/time.ts';
import type { TimeEntry } from '../../src/weeek/types.ts';
import { createHarness, task } from '../helpers/harness.ts';

const THURSDAY = new Date(2026, 9, 8, 15, 0);

function entry(userId: string, date: string, minutes: number, overrides: Partial<TimeEntry> = {}): TimeEntry {
  return { id: `${userId}-${date}`, userId, type: 2, isOvertime: false, date, duration: minutes, durationSeconds: minutes * 60, comment: null, ...overrides };
}

describe('resolveRange', () => {
  const cases: [string, { from: string; to: string }][] = [
    ['today', { from: '2026-10-08', to: '2026-10-08' }],
    ['yesterday', { from: '2026-10-07', to: '2026-10-07' }],
    ['this-week', { from: '2026-10-05', to: '2026-10-11' }],
    ['last-week', { from: '2026-09-28', to: '2026-10-04' }],
    ['this-month', { from: '2026-10-01', to: '2026-10-31' }],
    ['last-month', { from: '2026-09-01', to: '2026-09-30' }],
  ];
  for (const [period, expected] of cases) {
    it(`computes ${period}`, () => {
      assert.deepEqual(resolveRange(period as 'today', undefined, undefined, THURSDAY), expected);
    });
  }

  it('defaults to this week and handles Sunday', () => {
    assert.deepEqual(resolveRange(undefined, undefined, undefined, new Date(2026, 9, 11, 23, 0)), { from: '2026-10-05', to: '2026-10-11' });
  });

  it('uses explicit dates and defaults `to` to today', () => {
    assert.deepEqual(resolveRange('today', '2026-09-15', '2026-09-20', THURSDAY), { from: '2026-09-15', to: '2026-09-20' });
    assert.deepEqual(resolveRange(undefined, '2026-10-01', undefined, THURSDAY), { from: '2026-10-01', to: '2026-10-08' });
  });

  it('rejects bad dates', () => {
    assert.throws(() => resolveRange(undefined, undefined, '2026-10-01', THURSDAY), /Pass `from` together with `to`/);
    assert.throws(() => resolveRange(undefined, '01.10.2026', undefined, THURSDAY), /"from" must be YYYY-MM-DD/);
    assert.throws(() => resolveRange(undefined, '2026-10-09', '2026-10-01', THURSDAY), /must not be later/);
  });
});

describe('weeek_time_report', () => {
  function tasksWithTime() {
    return {
      tasks: [
        task({ id: 1, title: 'Вход', timeEntries: [entry('7', '2026-10-06', 90), entry('8', '2026-10-07', 30), entry('7', '2026-09-30', 600)] }),
        task({ id: 2, title: 'Отчёт', projectId: 20, timeEntries: [entry('7', '2026-10-07', 0, { type: 1, durationSeconds: 2700 })] }),
        task({ id: 3, title: 'Удалена', isDeleted: true, timeEntries: [entry('7', '2026-10-07', 300)] }),
        task({ id: 4, title: 'Без времени' }),
      ],
      hasMore: false,
    };
  }

  it('totals the configured project by task for the current week', async () => {
    const harness = await createHarness({ now: THURSDAY });
    harness.fake.on('GET', '/tm/tasks', tasksWithTime());
    const text = await harness.ok('weeek_time_report');
    assert.equal(
      text,
      [
        'Time report 2026-10-05 — 2026-10-11 · project Alpha (10) · all members',
        'Total: 2 h 45 min in 3 entries',
        '',
        'By task:',
        '- #1 Вход — 2 h',
        '- #2 Отчёт — 45 min',
      ].join('\n'),
    );
    const [call] = harness.fake.callsTo('GET', '/tm/tasks');
    assert.equal(call?.query.get('projectId'), '10');
    assert.equal(call?.query.get('all'), '1');
  });

  it('groups by day, member and project and filters by member', async () => {
    const harness = await createHarness({ now: THURSDAY });
    harness.fake.on('GET', '/tm/tasks', tasksWithTime());
    assert.match(await harness.ok('weeek_time_report', { groupBy: 'day' }), /By day:\n- 2026-10-06 — 1 h 30 min\n- 2026-10-07 — 1 h 15 min$/);
    assert.match(await harness.ok('weeek_time_report', { groupBy: 'member' }), /By member:\n- Анна Петрова — 2 h 15 min\n- Иван Сидоров — 30 min$/);
    assert.match(await harness.ok('weeek_time_report', { project: 'all', groupBy: 'project' }), /all projects[\s\S]*By project:\n- Alpha \(10\) — 2 h\n- Beta \(20\) — 45 min$/);
    assert.match(await harness.ok('weeek_time_report', { member: 'Иван' }), /· Иван Сидоров\nTotal: 30 min in 1 entry/);
    assert.equal(harness.fake.calls.filter((call) => call.path === '/tm/tasks').at(-2)?.query.has('projectId'), false);
  });

  it('says when there is nothing to report', async () => {
    const harness = await createHarness({ now: THURSDAY });
    harness.fake.on('GET', '/tm/tasks', (request) => ({
      tasks: tasksWithTime().tasks.filter((item) => String(item.projectId) === request.query.get('projectId')),
      hasMore: false,
    }));
    assert.equal(
      await harness.ok('weeek_time_report', { period: 'last-month', project: 'Beta' }),
      'Time report 2026-09-01 — 2026-09-30 · project Beta (20) · all members\nNo time entries in this period.',
    );
  });

  it('needs a project when there is no config', async () => {
    const harness = await createHarness({ config: null });
    assert.match(await harness.fail('weeek_time_report'), /No project given and no \.weeek\.json found/);
  });
});
