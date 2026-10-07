import { PRIORITIES, type Task, type TimeEntry } from '../weeek/types.ts';

export type Labels = {
  members: Map<string, string>;
  tags: Map<number, string>;
};

export function priorityName(priority: number | null): string | undefined {
  return priority === null ? undefined : PRIORITIES[priority];
}

export function taskRow(task: Task, labels: Labels, extras: string[] = []): string {
  const parts = [
    task.isCompleted ? 'completed' : '',
    task.isDeleted ? 'deleted' : '',
    priorityName(task.priority) ?? '',
    dueLabel(task),
    ...task.assignees.map((id) => `@${labels.members.get(id) ?? id}`),
    ...task.tags.map((id) => `#${labels.tags.get(id) ?? id}`),
    task.attachments.length > 0 ? plural(task.attachments.length, 'file') : '',
    ...extras,
  ].filter(Boolean);
  return `#${task.id} ${task.title}${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`;
}

export function dueLabel(task: Task): string {
  const due = task.dueDateTime ?? task.dueDate;
  return due ? `due ${formatMoment(due)}` : '';
}

export function datesLine(task: Task): string | undefined {
  const start = task.startDateTime ?? task.startDate;
  const due = task.dueDateTime ?? task.dueDate;
  const parts = [start ? `start ${formatMoment(start)}` : '', due ? `due ${formatMoment(due)}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function formatMoment(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0 min';
  if (seconds < 60) return '<1 min';
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function entrySeconds(entry: TimeEntry): number {
  return typeof entry.durationSeconds === 'number' ? entry.durationSeconds : entry.duration * 60;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function taskLink(workspaceId: number, task: Pick<Task, 'id' | 'projectId' | 'boardId'>): string | undefined {
  if (task.projectId === null || task.boardId === null) return undefined;
  return `https://app.weeek.net/ws/${workspaceId}/project/${task.projectId}/board/${task.boardId}?modals=m_task&m_task_workspace-id=${workspaceId}&m_task_id=${task.id}`;
}
