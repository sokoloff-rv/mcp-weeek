import { UserError } from '../errors.ts';
import { entrySeconds, formatDuration, plural } from '../format/task-view.ts';
import type { Tool } from '../mcp/tool.ts';
import { memberName } from '../weeek/names.ts';
import type { Member, Project, Task, TimeEntry } from '../weeek/types.ts';
import { defineTool, READ_ONLY, schema } from './define.ts';
import { openScope, type Deps } from './deps.ts';

const PERIODS = ['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month'] as const;
type Period = (typeof PERIODS)[number];
const GROUPS = ['task', 'day', 'member', 'project'] as const;
type Group = (typeof GROUPS)[number];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Row = { task: Task; entry: TimeEntry };

export function timeTools(deps: Deps): Tool[] {
  return [
    defineTool({
      name: 'weeek_time_report',
      title: 'Time report',
      description: [
        'Report of the time tracked in Weeek (manual entries and timer) for a period: total plus totals per task, day, member or project.',
        'Read-only: this server never logs time. Scope defaults to the project of .weeek.json; pass project "all" for the whole workspace.',
        'The period defaults to the current week (Monday to Sunday); dates are inclusive.',
      ].join(' '),
      properties: {
        period: schema.oneOf(PERIODS, 'Ready-made period, used when from/to are not given. Default: this-week.'),
        from: schema.text('First day, YYYY-MM-DD.'),
        to: schema.text('Last day, YYYY-MM-DD; defaults to today when only `from` is given.'),
        project: schema.text('Project name or id, or "all" for every project of the workspace.'),
        member: schema.text('Only entries of this member: name, email, id or "me".'),
        groupBy: schema.oneOf(GROUPS, 'Grouping: task (default), day, member or project.'),
      },
      annotations: READ_ONLY,
      run: async (args, { signal }) => {
        const range = resolveRange(args.oneOf('period', PERIODS), args.string('from')?.trim(), args.string('to')?.trim(), deps.now());
        const groupBy = args.oneOf('groupBy', GROUPS) ?? 'task';
        const { resolver } = await openScope(deps, signal);
        const projectRef = args.ref('project');
        const everywhere = typeof projectRef === 'string' && projectRef.toLowerCase() === 'all';
        const project = everywhere ? undefined : await resolver.project(projectRef);
        const memberRef = args.string('member');
        const member = memberRef === undefined ? undefined : await resolver.member(memberRef);

        const tasks = await deps.api.tasks({ projectId: project?.id, all: true }, signal);
        const rows: Row[] = tasks
          .filter((task) => !task.isDeleted)
          .flatMap((task) => task.timeEntries.map((entry) => ({ task, entry })))
          .filter(({ entry }) => entry.date >= range.from && entry.date <= range.to && (!member || entry.userId === member.id));

        const [members, projects] = await Promise.all([deps.directory.members.get(signal), deps.directory.projects.get(signal)]);
        const total = rows.reduce((sum, row) => sum + entrySeconds(row.entry), 0);
        const header = [
          `Time report ${range.from} — ${range.to}`,
          project ? `project ${project.title} (${project.id})` : 'all projects',
          member ? memberName(member) : 'all members',
        ].join(' · ');
        if (rows.length === 0) return `${header}\nNo time entries in this period.`;
        return [
          header,
          `Total: ${formatDuration(total)} in ${plural(rows.length, 'entry', 'entries')}`,
          '',
          `By ${groupBy}:`,
          ...group(rows, groupBy, members, projects).map(({ label, seconds }) => `- ${label} — ${formatDuration(seconds)}`),
        ].join('\n');
      },
    }),
  ];
}

function group(rows: Row[], groupBy: Group, members: Member[], projects: Project[]): { label: string; seconds: number }[] {
  const totals = new Map<string, { label: string; seconds: number }>();
  for (const { task, entry } of rows) {
    const [key, label] = groupKey(groupBy, task, entry, members, projects);
    const current = totals.get(key) ?? { label, seconds: 0 };
    current.seconds += entrySeconds(entry);
    totals.set(key, current);
  }
  const result = [...totals.entries()];
  if (groupBy === 'day') return result.sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  return result.map(([, value]) => value).sort((a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label));
}

function groupKey(groupBy: Group, task: Task, entry: TimeEntry, members: Member[], projects: Project[]): [string, string] {
  switch (groupBy) {
    case 'day':
      return [entry.date, entry.date];
    case 'member': {
      const member = members.find((candidate) => candidate.id === entry.userId);
      return [entry.userId, member ? memberName(member) : entry.userId];
    }
    case 'project': {
      const project = projects.find((candidate) => candidate.id === task.projectId);
      return [String(task.projectId), project ? `${project.title} (${project.id})` : task.projectId === null ? 'Without project' : `Project ${task.projectId}`];
    }
    default:
      return [String(task.id), `#${task.id} ${task.title}`];
  }
}

export function resolveRange(period: Period | undefined, from: string | undefined, to: string | undefined, now: Date): { from: string; to: string } {
  const today = localDate(now);
  if (from !== undefined || to !== undefined) {
    if (from === undefined) throw new UserError('Pass `from` together with `to`.');
    const end = to ?? today;
    for (const [name, value] of [['from', from], ['to', end]] as const) {
      if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new UserError(`Parameter "${name}" must be YYYY-MM-DD.`);
    }
    if (from > end) throw new UserError('`from` must not be later than `to`.');
    return { from, to: end };
  }
  const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const shift = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  const monday = shift(day, -((day.getUTCDay() + 6) % 7));
  const firstOfMonth = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  switch (period ?? 'this-week') {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: iso(shift(day, -1)), to: iso(shift(day, -1)) };
    case 'last-week':
      return { from: iso(shift(monday, -7)), to: iso(shift(monday, -1)) };
    case 'this-month':
      return { from: iso(firstOfMonth), to: iso(shift(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1)), -1)) };
    case 'last-month':
      return { from: iso(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() - 1, 1))), to: iso(shift(firstOfMonth, -1)) };
    default:
      return { from: iso(monday), to: iso(shift(monday, 6)) };
  }
}

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
