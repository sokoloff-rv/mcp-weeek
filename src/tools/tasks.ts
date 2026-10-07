import { htmlToMarkdown } from '../format/html-to-markdown.ts';
import { markdownToHtml } from '../format/markdown-to-html.ts';
import {
  datesLine,
  entrySeconds,
  formatDuration,
  formatMoment,
  formatSize,
  plural,
  priorityName,
  taskLink,
  taskRow,
  type Labels,
} from '../format/task-view.ts';
import { UserError } from '../errors.ts';
import type { Tool } from '../mcp/tool.ts';
import type { Resolver } from '../resolve.ts';
import type { UpdateTaskBody } from '../weeek/api.ts';
import { WeeekError } from '../weeek/client.ts';
import { memberName } from '../weeek/names.ts';
import { PRIORITIES, type Board, type Column, type Comment, type Task } from '../weeek/types.ts';
import type { Args, DateValue } from './args.ts';
import { attachFiles, prepareAttachments } from './attachments.ts';
import { defineTool, READ_ONLY, schema, UNTRUSTED_NOTE, WRITE } from './define.ts';
import { openScope, type Deps } from './deps.ts';

const LIST_LIMIT = 200;
const SUBTASKS_SHOWN = 30;
const CLOCK_SKEW_MS = 2 * 60_000;
const PRIORITY_VALUES = [...PRIORITIES, 'none'] as const;

const taskId = schema.id('Task id, e.g. 1149170 (shown as #1149170).');

export function taskTools(deps: Deps): Tool[] {
  return [
    defineTool({
      name: 'weeek_list_tasks',
      title: 'List tasks of a board',
      description: [
        'Lists tasks of a board grouped by columns, in board order: one short line per task with id, title, priority, due date, assignees, tags and number of files.',
        'Subtasks are shown under their parent. Completed tasks are hidden unless `completed` says otherwise.',
        'Use weeek_get_task for the description, comments and attachments of one task.',
        'Board defaults to the first board of .weeek.json.',
        UNTRUSTED_NOTE,
      ].join(' '),
      properties: {
        board: schema.text('Board name, alias from .weeek.json or id. Defaults to the configured board.'),
        column: schema.text('Only this column: name, alias (e.g. "queue", "testing") or id.'),
        search: schema.text('Text to search in task titles and descriptions.'),
        assignee: schema.text('Only tasks assigned to this member: name, email, id or "me".'),
        tag: schema.text('Only tasks with this tag (title or id).'),
        completed: schema.oneOf(['exclude', 'include', 'only'], 'Completed tasks: "exclude" (default), "include" or "only".'),
      },
      annotations: READ_ONLY,
      run: async (args, { signal }) => {
        const { resolver } = await openScope(deps, signal);
        const board = await resolver.board(args.ref('board'));
        const columnRef = args.ref('column');
        const column = columnRef === undefined ? undefined : await resolver.column(board, columnRef);
        const assigneeRef = args.string('assignee');
        const assignee = assigneeRef === undefined ? undefined : await resolver.member(assigneeRef);
        const tagRef = args.ref('tag');
        const [tag] = tagRef === undefined ? [] : await resolver.tags([tagRef]);
        const completed = args.oneOf('completed', ['exclude', 'include', 'only']) ?? 'exclude';

        const found = await deps.api.tasks(
          {
            projectId: board.projectId,
            boardId: board.id,
            boardColumnId: column?.id,
            search: args.string('search')?.trim(),
            completed: completed === 'include' ? undefined : completed === 'only',
          },
          signal,
        );
        const tasks = found.filter(
          (task) => !task.isDeleted && (!assignee || task.assignees.includes(assignee.id)) && (!tag || task.tags.includes(tag.id)),
        );
        const labels = await loadLabels(resolver, tasks);
        const columns = column ? [column] : await resolver.columns(board);
        return renderBoard(resolver, board, columns, tasks, labels, completed);
      },
    }),

    defineTool({
      name: 'weeek_get_task',
      title: 'Get a task',
      description: [
        'Full card of one task: project, board and column, status, priority, dates, assignees, tags, parent and subtasks,',
        'the description converted to Markdown, attachments (name, size, id for weeek_get_attachment), time entries and all comments, oldest first, with authors.',
        UNTRUSTED_NOTE,
      ].join(' '),
      properties: { id: taskId },
      required: ['id'],
      annotations: READ_ONLY,
      run: async (args, { signal }) => {
        const id = args.id('id', { required: true });
        const { resolver } = await openScope(deps, signal);
        const task = await deps.api.task(id, signal);
        const [comments, workspace, related, place] = await Promise.all([
          deps.api.comments(id, signal),
          deps.directory.workspace.get(signal),
          loadRelated(deps, task, signal),
          describePlace(resolver, task),
        ]);
        const people = [task.authorId, ...task.timeEntries.map((entry) => entry.userId), ...comments.map((comment) => comment.authorId)];
        const labels = await loadLabels(resolver, [task, ...related.subtasks], people);
        return renderCard({ task, comments, labels, place, workspaceId: workspace.id, ...related });
      },
    }),

    defineTool({
      name: 'weeek_create_task',
      title: 'Create a task',
      description: [
        'Creates a task on a board: title, Markdown description (stored as HTML), column, assignees, tags, priority, dates and files to attach.',
        'Board and column default to .weeek.json (defaultColumn). Pass `parent` to create a subtask: it stays in the parent\'s project and goes to a board only if `board` or `column` is given.',
        'If Weeek fails while creating, the server checks whether the task appeared anyway, so the call is safe to retry: it never creates a duplicate on its own.',
        'Follow the conventions from weeek_context. Tags must already exist in Weeek.',
      ].join(' '),
      properties: {
        title: schema.text('Short task title.'),
        description: schema.text('Task description in Markdown. Pasted text from the user goes here as is.'),
        board: schema.text('Board name, alias or id. Defaults to the configured board.'),
        column: schema.text('Column name, alias (e.g. "queue") or id. Defaults to defaultColumn of .weeek.json, else the first column.'),
        parent: schema.id('Parent task id to create a subtask.'),
        assignees: schema.list('Members to assign: names, emails, ids or "me".'),
        tags: schema.list('Existing tag titles or ids.'),
        priority: schema.oneOf(PRIORITIES, 'Priority.'),
        startDate: schema.text('Start date: YYYY-MM-DD, or an ISO date-time with time zone.'),
        dueDate: schema.text('Due date: YYYY-MM-DD, or an ISO date-time with time zone.'),
        attachments: schema.list('Paths of files to attach (screenshots etc.); only files inside attachRoots of .weeek.json are allowed.'),
      },
      required: ['title'],
      annotations: WRITE,
      run: (args, { signal }) => createTask(deps, args, signal),
    }),

    defineTool({
      name: 'weeek_update_task',
      title: 'Update a task',
      description: [
        'Changes fields of a task: title, priority, start and due dates, time estimate, completion, parent, assignees and tags.',
        'The Weeek API cannot change the description of an existing task: add a comment instead.',
        'Pass an empty string to clear a date. `completed: true` only ticks the task as done; it does not move it to another column (use weeek_move_task).',
      ].join(' '),
      properties: {
        id: taskId,
        title: schema.text('New title.'),
        priority: schema.oneOf(PRIORITY_VALUES, 'New priority; "none" clears it.'),
        startDate: schema.text('YYYY-MM-DD or ISO date-time with time zone; empty string clears.'),
        dueDate: schema.text('YYYY-MM-DD or ISO date-time with time zone; empty string clears.'),
        estimateMinutes: { type: 'integer', minimum: 0, description: 'Time estimate in minutes; 0 clears it.' },
        completed: schema.boolean('true marks the task completed, false returns it to work.'),
        parent: schema.text('Parent task id to make it a subtask, or "none" to detach it from its parent.'),
        addAssignees: schema.list('Members to add: names, emails, ids or "me".'),
        removeAssignees: schema.list('Members to remove.'),
        addTags: schema.list('Existing tags to add (titles or ids).'),
        removeTags: schema.list('Tags to remove.'),
      },
      required: ['id'],
      hints: {
        description: 'The Weeek API cannot change the description of an existing task (it silently ignores it). Add a comment with weeek_add_comment instead.',
      },
      annotations: { ...WRITE, idempotentHint: true },
      run: (args, { signal }) => updateTask(deps, args, signal),
    }),

    defineTool({
      name: 'weeek_move_task',
      title: 'Move a task',
      description: [
        'Moves a task to another column and/or board. Column is a name, alias from .weeek.json (e.g. "testing") or id, looked up on the target board:',
        'the given `board`, otherwise the board the task is on. With only `board`, the task lands in the first column of that board.',
        'Follow the conventions from weeek_context about which columns you may move tasks to.',
      ].join(' '),
      properties: {
        id: taskId,
        column: schema.text('Target column: name, alias or id.'),
        board: schema.text('Target board: name, alias or id.'),
      },
      required: ['id'],
      annotations: { ...WRITE, idempotentHint: true },
      run: async (args, { signal }) => {
        const id = args.id('id', { required: true });
        const boardRef = args.ref('board');
        const columnRef = args.ref('column');
        if (boardRef === undefined && columnRef === undefined) throw new UserError('Pass `column`, `board` or both.');
        const { resolver } = await openScope(deps, signal);
        const task = await deps.api.task(id, signal);
        const before = await describePlace(resolver, task);
        const board =
          boardRef !== undefined ? await resolver.board(boardRef) : task.boardId !== null ? await resolver.board(task.boardId) : await resolver.board();
        if (columnRef !== undefined) {
          const column = await resolver.column(board, columnRef);
          if (task.boardColumnId === column.id) return `Task #${id} "${task.title}" is already in ${placeLabel(resolver, board, column)}.`;
          await deps.api.moveToColumn(id, column.id, signal);
          return `Moved #${id} "${task.title}": ${before} → ${placeLabel(resolver, board, column)}.`;
        }
        if (task.boardId === board.id) return `Task #${id} "${task.title}" is already on board ${board.name}.`;
        const moved = await deps.api.moveToBoard(id, board.id, signal);
        const column = (await resolver.columns(board)).find((candidate) => candidate.id === moved.boardColumnId);
        return `Moved #${id} "${task.title}": ${before} → ${placeLabel(resolver, board, column)}.`;
      },
    }),
  ];
}

async function createTask(deps: Deps, args: Args, signal: AbortSignal): Promise<string> {
  const title = args.string('title', { required: true }).trim();
  const description = args.string('description');
  const parentId = args.id('parent');
  const boardRef = args.ref('board');
  const columnRef = args.ref('column');
  const priority = args.oneOf('priority', PRIORITIES);
  const startDate = args.date('startDate');
  const dueDate = args.date('dueDate');
  const { loaded, resolver } = await openScope(deps, signal);

  const parent = parentId === undefined ? undefined : await deps.api.task(parentId, signal);
  const needsBoard = parent === undefined || boardRef !== undefined || columnRef !== undefined;
  const board = needsBoard ? await resolver.board(boardRef ?? (parent?.boardId ?? undefined)) : undefined;
  const column = board ? (columnRef !== undefined ? await resolver.column(board, columnRef) : await resolver.defaultColumn(board)) : undefined;
  const projectId = board?.projectId ?? parent?.projectId ?? undefined;
  if (projectId === undefined) throw new UserError(`Parent task #${parentId} has no project; pass board.`);
  const assignees = await resolveMembers(resolver, args.strings('assignees'));
  const tags = await resolver.tags(args.refs('tags') ?? []);
  const files = await prepareAttachments(loaded, args.strings('attachments'), deps.homeDir);
  datesBody(NO_DATES, startDate, dueDate);

  const me = await resolver.me();
  const started = deps.now().getTime();
  const body = {
    title,
    ...(description === undefined ? {} : { description: markdownToHtml(description) }),
    ...(parentId === undefined ? {} : { parentId }),
    ...(priority === undefined ? {} : { priority: PRIORITIES.indexOf(priority) }),
    locations: [{ projectId, ...(board ? { boardId: board.id } : {}), ...(column ? { boardColumnId: column.id } : {}) }],
  };

  let task: Task;
  let recovered = false;
  try {
    task = await deps.api.createTask(body, signal);
  } catch (error) {
    if (!(error instanceof WeeekError) || !error.transient) throw error;
    const existing = await findCreatedTask(deps, { projectId, title, authorId: me.id, since: started - CLOCK_SKEW_MS }, signal);
    if (!existing) {
      throw new UserError(`${error.message} The task was not created: checked the project for "${title}". It is safe to retry.`);
    }
    task = existing;
    recovered = true;
  }

  const problems: string[] = [];
  const done: string[] = [];
  const update: UpdateTaskBody = datesBody(task, startDate, dueDate);
  if (tags.length > 0) update.tags = tags.map((tag) => tag.id);
  if (Object.keys(update).length > 0) {
    await attempt(problems, 'dates and tags', () => deps.api.updateTask(task.id, update, signal));
  }
  if (assignees.length > 0) {
    await attempt(problems, 'assignees', () => deps.api.addAssignees(task.id, assignees.map((member) => member.id), signal));
  }
  if (files.length > 0) {
    await attempt(problems, 'attachments', async () => {
      const attached = await attachFiles(deps, task.id, files, me.id, signal);
      done.push(`Attached: ${attached.map((file) => `${file.name} (${formatSize(file.size)})`).join(', ')}`);
    });
  }

  const workspace = await deps.directory.workspace.get(signal);
  const where = board && column ? placeLabel(resolver, board, column) : `project ${projectId}${parent ? ` as a subtask of #${parent.id}` : ''}`;
  const link = taskLink(workspace.id, { id: task.id, projectId, boardId: board?.id ?? null });
  return [
    `Created task #${task.id} "${task.title}" in ${where}${parent && board ? `, subtask of #${parent.id}` : ''}.`,
    ...(recovered ? ['Weeek answered with an error, but the task had been created: no duplicate was made.'] : []),
    ...(link ? [`Link: ${link}`] : []),
    ...done,
    ...(problems.length > 0 ? [`Not done (the task exists; fix with weeek_update_task or weeek_attach_files): ${problems.join('; ')}`] : []),
  ].join('\n');
}

async function updateTask(deps: Deps, args: Args, signal: AbortSignal): Promise<string> {
  const id = args.id('id', { required: true });
  const title = args.string('title')?.trim();
  const priority = args.oneOf('priority', PRIORITY_VALUES);
  const startDate = args.date('startDate');
  const dueDate = args.date('dueDate');
  const estimate = args.integer('estimateMinutes', 0);
  const completed = args.boolean('completed');
  const parentRef = args.string('parent')?.trim();
  const addAssignees = args.strings('addAssignees');
  const removeAssignees = args.strings('removeAssignees');
  const addTags = args.refs('addTags');
  const removeTags = args.refs('removeTags');
  const { resolver } = await openScope(deps, signal);

  const changes: string[] = [];
  const body: UpdateTaskBody = {};
  if (title !== undefined) {
    body.title = title;
    changes.push(`title → "${title}"`);
  }
  if (priority !== undefined) {
    body.priority = priority === 'none' ? null : PRIORITIES.indexOf(priority);
    changes.push(`priority → ${priority}`);
  }
  if (startDate) changes.push(`start → ${describeDate(startDate)}`);
  if (dueDate) changes.push(`due → ${describeDate(dueDate)}`);
  if (estimate !== undefined) {
    body.duration = estimate === 0 ? null : estimate;
    changes.push(`estimate → ${estimate === 0 ? 'none' : formatDuration(estimate * 60)}`);
  }

  const parentId = parentRef === undefined ? undefined : parentRef.toLowerCase() === 'none' ? null : Number(parentRef);
  if (parentId !== undefined && parentId !== null && (!Number.isInteger(parentId) || parentId <= 0 || parentId === id)) {
    throw new UserError('Parameter "parent" must be another task id or "none".');
  }
  const assigneesToAdd = await resolveMembers(resolver, addAssignees);
  const assigneesToRemove = await resolveMembers(resolver, removeAssignees);
  const tagsToAdd = await resolver.tags(addTags ?? []);
  const tagsToRemove = await resolver.tags(removeTags ?? []);

  const nothing =
    Object.keys(body).length === 0 &&
    startDate === undefined &&
    dueDate === undefined &&
    completed === undefined &&
    parentId === undefined &&
    assigneesToAdd.length + assigneesToRemove.length + tagsToAdd.length + tagsToRemove.length === 0;
  if (nothing) throw new UserError('Nothing to update: pass at least one field besides id.');

  const current = await deps.api.task(id, signal);
  Object.assign(body, datesBody(current, startDate, dueDate));
  if (dueDate?.kind === 'clear' && startDate === undefined && (current.startDate || current.startDateTime)) {
    changes.push('start → none (Weeek keeps no start without a due date)');
  }

  if (tagsToAdd.length + tagsToRemove.length > 0) {
    const removed = new Set(tagsToRemove.map((tag) => tag.id));
    body.tags = [...new Set([...current.tags, ...tagsToAdd.map((tag) => tag.id)])].filter((tagId) => !removed.has(tagId));
    changes.push(...tagsToAdd.map((tag) => `tag + ${tag.title}`), ...tagsToRemove.map((tag) => `tag − ${tag.title}`));
  }
  if (Object.keys(body).length > 0) await deps.api.updateTask(id, body, signal);
  if (completed !== undefined && completed !== current.isCompleted) {
    await deps.api.setCompleted(id, completed, signal);
    changes.push(completed ? 'completed' : 'returned to work');
  }
  if (parentId !== undefined) {
    await deps.api.setParent(id, parentId, signal);
    changes.push(parentId === null ? 'detached from its parent' : `parent → #${parentId}`);
  }
  if (assigneesToAdd.length > 0) {
    await deps.api.addAssignees(id, assigneesToAdd.map((member) => member.id), signal);
    changes.push(...assigneesToAdd.map((member) => `assignee + ${memberName(member)}`));
  }
  if (assigneesToRemove.length > 0) {
    await deps.api.removeAssignees(id, assigneesToRemove.map((member) => member.id), signal);
    changes.push(...assigneesToRemove.map((member) => `assignee − ${memberName(member)}`));
  }
  return `Updated #${id} "${title ?? current.title}": ${changes.join(', ') || 'no changes'}.`;
}

type TaskDates = Pick<Task, 'startDate' | 'dueDate' | 'startDateTime' | 'dueDateTime'>;
type SetDate = Exclude<DateValue, { kind: 'clear' }>;

const NO_DATES: TaskDates = { startDate: null, dueDate: null, startDateTime: null, dueDateTime: null };

/**
 * Weeek хранит начало и срок парой одного вида (даты или даты со временем): любой PUT с датой задаёт пару заново,
 * а пропущенное начало стирается. Поэтому отправляем пару целиком, дополняя её текущими значениями задачи.
 */
function datesBody(current: TaskDates, start: DateValue | undefined, due: DateValue | undefined): UpdateTaskBody {
  if (start === undefined && due === undefined) return {};
  const pick = (input: DateValue | undefined, date: string | null, dateTime: string | null): SetDate | undefined => {
    if (input !== undefined) return input.kind === 'clear' ? undefined : input;
    if (dateTime) return { kind: 'dateTime', value: dateTime };
    return date ? { kind: 'date', value: date } : undefined;
  };
  const clearsDue = due?.kind === 'clear';
  const nextStart = clearsDue && start === undefined ? undefined : pick(start, current.startDate, current.startDateTime);
  const nextDue = pick(due, current.dueDate, current.dueDateTime);
  if (!nextDue) {
    if (nextStart) throw new UserError('Weeek needs a due date when a start date is set: pass dueDate as well.');
    return { startDate: null, dueDate: null, startDateTime: null, dueDateTime: null };
  }
  if (nextStart && nextStart.kind !== nextDue.kind) {
    throw new UserError('Start and due must be of the same kind: both dates (YYYY-MM-DD) or both date-times. Pass both.');
  }
  if (nextDue.kind === 'date') return { ...(nextStart ? { startDate: nextStart.value } : {}), dueDate: nextDue.value };
  return { ...(nextStart ? { startDateTime: nextStart.value } : {}), dueDateTime: nextDue.value };
}

function describeDate(value: DateValue): string {
  return value.kind === 'clear' ? 'none' : formatMoment(value.value);
}

async function findCreatedTask(
  deps: Deps,
  query: { projectId: number; title: string; authorId: string; since: number },
  signal: AbortSignal,
): Promise<Task | undefined> {
  const candidates = await deps.api.tasks({ projectId: query.projectId, search: query.title }, signal);
  return candidates
    .filter((task) => task.title === query.title && task.authorId === query.authorId && Date.parse(task.createdAt) >= query.since)
    .sort((a, b) => b.id - a.id)[0];
}

async function attempt(problems: string[], what: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    problems.push(`${what}: ${error.message}`);
  }
}

async function resolveMembers(resolver: Resolver, refs: string[] | undefined) {
  return Promise.all((refs ?? []).map((ref) => resolver.member(ref)));
}

export async function loadLabels(resolver: Resolver, tasks: Task[], extraMembers: string[] = []): Promise<Labels> {
  const memberIds = [...new Set([...tasks.flatMap((task) => task.assignees), ...extraMembers])];
  const tagIds = [...new Set(tasks.flatMap((task) => task.tags))];
  const [members, tagTitles] = await Promise.all([resolver.memberNames(memberIds), resolver.tagTitles(tagIds)]);
  return { members, tags: new Map(tagIds.map((id, index) => [id, tagTitles[index] ?? `${id}`])) };
}

function renderBoard(resolver: Resolver, board: Board, columns: Column[], tasks: Task[], labels: Labels, completed: string): string {
  const alias = resolver.boardAlias(board);
  const lines = [
    `Board ${board.name} (${board.id})${alias ? ` [${alias}]` : ''}: ${plural(tasks.length, 'task')}${completed === 'exclude' ? ', completed hidden' : completed === 'only' ? ', completed only' : ''}.`,
  ];
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<number, Task[]>();
  for (const task of tasks) {
    if (task.parentId !== null && ids.has(task.parentId)) children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  const topLevel = tasks.filter((task) => task.parentId === null || !ids.has(task.parentId));
  let shown = 0;
  const groups = [
    ...columns.map((column) => ({ title: `${column.name} (${column.id})${resolver.columnAlias(column) ? ` [${resolver.columnAlias(column)}]` : ''}`, id: column.id as number | null })),
  ];
  const known = new Set(columns.map((column) => column.id));
  if (topLevel.some((task) => task.boardColumnId === null || !known.has(task.boardColumnId))) groups.push({ title: 'Without column', id: null });

  for (const group of groups) {
    const inGroup = topLevel.filter((task) => (group.id === null ? task.boardColumnId === null || !known.has(task.boardColumnId) : task.boardColumnId === group.id));
    lines.push('', `## ${group.title} — ${inGroup.length}`);
    for (const task of inGroup) {
      if (shown >= LIST_LIMIT) break;
      const subtasks = children.get(task.id) ?? [];
      const extras = task.subTasks.length > 0 ? [`subtasks: ${task.subTasks.length}`] : [];
      const parentNote = task.parentId !== null ? [`subtask of #${task.parentId}`] : [];
      lines.push(`- ${taskRow(task, labels, [...extras, ...parentNote])}`);
      shown++;
      for (const subtask of subtasks) lines.push(`  - ${taskRow(subtask, labels)}`);
    }
  }
  if (shown >= LIST_LIMIT && topLevel.length > LIST_LIMIT) {
    lines.push('', `${topLevel.length - LIST_LIMIT} more tasks are not shown: narrow the list with column, search, assignee or tag.`);
  }
  return lines.join('\n');
}

type Related = { parent: Task | undefined; subtasks: Task[] };

async function loadRelated(deps: Deps, task: Task, signal: AbortSignal): Promise<Related> {
  const load = (id: number) => deps.api.task(id, signal).catch((error: unknown) => (error instanceof UserError ? undefined : Promise.reject(error)));
  const [parent, ...subtasks] = await Promise.all([
    task.parentId === null ? Promise.resolve(undefined) : load(task.parentId),
    ...task.subTasks.slice(0, SUBTASKS_SHOWN).map(load),
  ]);
  return { parent, subtasks: subtasks.filter((subtask): subtask is Task => subtask !== undefined && !subtask.isDeleted) };
}

async function describePlace(resolver: Resolver, task: Task): Promise<string> {
  if (task.boardId === null) return task.projectId === null ? 'no project' : `project ${task.projectId}, no board`;
  try {
    const board = await resolver.board(task.boardId);
    const column = (await resolver.columns(board)).find((candidate) => candidate.id === task.boardColumnId);
    return placeLabel(resolver, board, column);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return `board ${task.boardId}, column ${task.boardColumnId ?? 'none'}`;
  }
}

function placeLabel(resolver: Resolver, board: Board, column: Column | undefined): string {
  const alias = column ? resolver.columnAlias(column) : undefined;
  return `${board.name} / ${column ? `${column.name}${alias ? ` [${alias}]` : ''}` : 'no column'}`;
}

type CardInput = Related & { task: Task; comments: Comment[]; labels: Labels; place: string; workspaceId: number };

function renderCard({ task, comments, labels, place, workspaceId, parent, subtasks }: CardInput): string {
  const name = (id: string) => labels.members.get(id) ?? id;
  const link = taskLink(workspaceId, task);
  const status = task.isDeleted ? 'deleted' : task.isCompleted ? `completed${task.completedAt ? ` ${formatMoment(task.completedAt)}` : ''}` : 'open';
  const lines = [
    `# #${task.id} ${task.title}`,
    `Where: ${place}${task.projectId !== null ? ` (project ${task.projectId})` : ''}`,
    `Status: ${status}`,
    ...(priorityName(task.priority) ? [`Priority: ${priorityName(task.priority)}`] : []),
    ...(datesLine(task) ? [`Dates: ${datesLine(task)}`] : []),
    ...(task.duration ? [`Estimate: ${formatDuration(task.duration * 60)}`] : []),
    ...(task.assignees.length > 0 ? [`Assignees: ${task.assignees.map(name).join(', ')}`] : []),
    ...(task.tags.length > 0 ? [`Tags: ${task.tags.map((id) => labels.tags.get(id) ?? id).join(', ')}`] : []),
    ...(parent ? [`Parent: #${parent.id} ${parent.title}`] : task.parentId !== null ? [`Parent: #${task.parentId}`] : []),
    `Created ${formatMoment(task.createdAt)} by ${name(task.authorId)}; updated ${formatMoment(task.updatedAt)}`,
    ...(link ? [`Link: ${link}`] : []),
  ];
  if (task.subTasks.length > 0) {
    lines.push('', `## Subtasks (${task.subTasks.length})`, ...subtasks.map((subtask) => `- ${taskRow(subtask, labels)}`));
    if (task.subTasks.length > subtasks.length) lines.push(`- …and ${task.subTasks.length - subtasks.length} more not shown`);
  }
  const description = htmlToMarkdown(task.description);
  lines.push('', '## Description', description || '(empty)');
  if (task.attachments.length > 0) {
    lines.push(
      '',
      `## Attachments (${task.attachments.length})`,
      ...task.attachments.map((file) => `- ${file.name} · ${formatSize(file.size)} · id ${file.id}`),
    );
  }
  if (task.timeEntries.length > 0) {
    const total = task.timeEntries.reduce((sum, entry) => sum + entrySeconds(entry), 0);
    lines.push(
      '',
      `## Time: ${formatDuration(total)}`,
      ...task.timeEntries.map((entry) => `- ${entry.date} · ${name(entry.userId)} · ${formatDuration(entrySeconds(entry))}${entry.type === 1 ? ' (timer)' : ''}${entry.isOvertime ? ' (overtime)' : ''}${entry.comment ? ` · ${entry.comment}` : ''}`),
    );
  }
  const ordered = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
  lines.push('', `## Comments (${comments.length}, oldest first)`);
  for (const comment of ordered) {
    const reply = comment.parentId !== null ? ` · reply to #${comment.parentId}` : '';
    lines.push('', `### Comment #${comment.id} · ${name(comment.authorId)} · ${formatMoment(comment.createdAt)}${reply}`, comment.markdown.trim());
  }
  return lines.join('\n');
}
