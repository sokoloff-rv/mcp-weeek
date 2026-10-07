export type Member = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  middleName?: string | null;
  timeZone?: string | null;
  roleType?: string;
};

export type Workspace = { id: number; title: string };

export type Project = { id: number; title: string; description?: string | null; isPrivate?: boolean };

export type Board = { id: number; name: string; projectId: number };

export type Column = { id: number; name: string; boardId: number };

export type Tag = { id: number; title: string; color?: string };

export type TimeEntry = {
  id: string;
  userId: string;
  type: number;
  isOvertime: boolean;
  date: string;
  duration: number;
  durationSeconds: number;
  comment: string | null;
};

export type Attachment = {
  id: string;
  name: string;
  size: number;
  url: string;
  createdAt: string;
  creatorId: string | null;
  service?: string;
};

export type TaskLocation = { projectId: number | null; boardId: number | null; boardColumnId: number | null };

export type Task = {
  id: number;
  parentId: number | null;
  title: string;
  description: string | null;
  type: string;
  priority: number | null;
  isCompleted: boolean;
  isDeleted: boolean;
  completedAt: string | null;
  authorId: string;
  userId: string | null;
  assignees: string[];
  projectId: number | null;
  boardId: number | null;
  boardColumnId: number | null;
  locations: TaskLocation[];
  startDate: string | null;
  dueDate: string | null;
  startDateTime: string | null;
  dueDateTime: string | null;
  duration: number | null;
  tags: number[];
  subTasks: number[];
  attachments: Attachment[];
  timeEntries: TimeEntry[];
  createdAt: string;
  updatedAt: string;
};

export type Comment = {
  id: number;
  parentId: number | null;
  authorId: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
};

export const PRIORITIES = ['low', 'medium', 'high', 'hold'] as const;
export type PriorityName = (typeof PRIORITIES)[number];
