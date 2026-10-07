import type { Query, WeeekClient } from './client.ts';
import type { Attachment, Board, Column, Comment, Member, Project, Tag, Task, Workspace } from './types.ts';

const TASKS_PAGE = 100;
const COMMENTS_PAGE = 100;
const MAX_TASKS = 5_000;

export type TaskFilter = {
  projectId?: number | undefined;
  boardId?: number | undefined;
  boardColumnId?: number | undefined;
  search?: string | undefined;
  completed?: boolean | undefined;
  all?: boolean | undefined;
};

export type CreateTaskBody = {
  title: string;
  description?: string;
  parentId?: number;
  priority?: number;
  locations: { projectId: number; boardId?: number; boardColumnId?: number }[];
};

export type UpdateTaskBody = {
  title?: string;
  priority?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  startDateTime?: string | null;
  dueDateTime?: string | null;
  duration?: number | null;
  tags?: number[];
};

export type UploadFile = { name: string; blob: Blob };

export class WeeekApi {
  readonly #client: WeeekClient;

  constructor(client: WeeekClient) {
    this.#client = client;
  }

  async me(signal?: AbortSignal): Promise<Member> {
    return (await this.#client.get<{ user: Member }>('/user/me', {}, signal)).user;
  }

  async workspace(signal?: AbortSignal): Promise<Workspace> {
    return (await this.#client.get<{ workspace: Workspace }>('/ws', {}, signal)).workspace;
  }

  async members(signal?: AbortSignal): Promise<Member[]> {
    return (await this.#client.get<{ members: Member[] }>('/ws/members', {}, signal)).members;
  }

  async tags(signal?: AbortSignal): Promise<Tag[]> {
    return (await this.#client.get<{ tags: Tag[] }>('/ws/tags', {}, signal)).tags;
  }

  async projects(signal?: AbortSignal): Promise<Project[]> {
    return (await this.#client.get<{ projects: Project[] }>('/tm/projects', {}, signal)).projects;
  }

  async boards(projectId: number, signal?: AbortSignal): Promise<Board[]> {
    return (await this.#client.get<{ boards: Board[] }>('/tm/boards', { projectId }, signal)).boards;
  }

  async columns(boardId: number, signal?: AbortSignal): Promise<Column[]> {
    return (await this.#client.get<{ boardColumns: Column[] }>('/tm/board-columns', { boardId }, signal)).boardColumns;
  }

  async task(id: number, signal?: AbortSignal): Promise<Task> {
    return (await this.#client.get<{ task: Task }>(`/tm/tasks/${id}`, {}, signal)).task;
  }

  async tasks(filter: TaskFilter, signal?: AbortSignal): Promise<Task[]> {
    const tasks: Task[] = [];
    for (let offset = 0; offset < MAX_TASKS; offset += TASKS_PAGE) {
      const query: Query = { ...filter, perPage: TASKS_PAGE, offset };
      const page = await this.#client.get<{ tasks: Task[]; hasMore: boolean }>('/tm/tasks', query, signal);
      tasks.push(...page.tasks);
      if (!page.hasMore || page.tasks.length === 0) break;
    }
    return tasks;
  }

  async createTask(body: CreateTaskBody, signal?: AbortSignal): Promise<Task> {
    return (await this.#client.post<{ task: Task }>('/tm/tasks', body, { signal })).task;
  }

  async updateTask(id: number, body: UpdateTaskBody, signal?: AbortSignal): Promise<Task> {
    return (await this.#client.put<{ task: Task }>(`/tm/tasks/${id}`, body, signal)).task;
  }

  async setCompleted(id: number, completed: boolean, signal?: AbortSignal): Promise<void> {
    await this.#client.post(`/tm/tasks/${id}/${completed ? 'complete' : 'un-complete'}`, {}, { retry: true, signal });
  }

  async moveToColumn(id: number, boardColumnId: number, signal?: AbortSignal): Promise<void> {
    await this.#client.post(`/tm/tasks/${id}/board-column`, { boardColumnId }, { retry: true, signal });
  }

  async moveToBoard(id: number, boardId: number, signal?: AbortSignal): Promise<{ boardId: number; boardColumnId: number }> {
    return this.#client.post(`/tm/tasks/${id}/board`, { boardId }, { retry: true, signal });
  }

  async setParent(id: number, parentId: number | null, signal?: AbortSignal): Promise<void> {
    await this.#client.post(`/tm/tasks/${id}/parent`, { parentId }, { retry: true, signal });
  }

  async addAssignees(id: number, assignees: string[], signal?: AbortSignal): Promise<void> {
    await this.#client.post(`/tm/tasks/${id}/assignees`, { assignees }, { retry: true, signal });
  }

  async removeAssignees(id: number, assignees: string[], signal?: AbortSignal): Promise<void> {
    await this.#client.delete(`/tm/tasks/${id}/assignees`, { assignees }, signal);
  }

  async comments(taskId: number, signal?: AbortSignal): Promise<Comment[]> {
    const comments: Comment[] = [];
    for (let offset = 0; ; offset += COMMENTS_PAGE) {
      const page = await this.#client.get<{ comments: Comment[]; hasMore: boolean }>(
        `/tm/tasks/${taskId}/comments`,
        { limit: COMMENTS_PAGE, offset },
        signal,
      );
      comments.push(...page.comments);
      if (!page.hasMore || page.comments.length === 0) return comments;
    }
  }

  async latestComments(taskId: number, limit: number, signal?: AbortSignal): Promise<Comment[]> {
    return (await this.#client.get<{ comments: Comment[] }>(`/tm/tasks/${taskId}/comments`, { limit }, signal)).comments;
  }

  async addComment(taskId: number, markdown: string, parentId: number | undefined, signal?: AbortSignal): Promise<Comment> {
    const body = parentId === undefined ? { markdown } : { markdown, parentId };
    return (await this.#client.post<{ comment: Comment }>(`/tm/tasks/${taskId}/comments`, body, { signal })).comment;
  }

  async deleteComment(taskId: number, commentId: number, signal?: AbortSignal): Promise<void> {
    await this.#client.delete(`/tm/tasks/${taskId}/comments/${commentId}`, undefined, signal);
  }

  async uploadAttachments(taskId: number, files: UploadFile[], signal?: AbortSignal): Promise<Attachment[]> {
    const form = new FormData();
    for (const file of files) form.append('files[]', file.blob, file.name);
    return (await this.#client.request<{ data: Attachment[] }>('POST', `/tm/tasks/${taskId}/attachments`, { form, signal })).data;
  }

  async attachment(id: string, signal?: AbortSignal): Promise<Attachment> {
    return (await this.#client.get<{ data: Attachment }>(`/ws/attachments/${encodeURIComponent(id)}`, {}, signal)).data;
  }
}
