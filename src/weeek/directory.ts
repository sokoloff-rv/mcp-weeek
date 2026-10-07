import type { WeeekApi } from './api.ts';
import type { Board, Column, Member, Project, Tag, Workspace } from './types.ts';

class Cached<T> {
  readonly #load: (signal?: AbortSignal) => Promise<T>;
  #value: Promise<T> | undefined;

  constructor(load: (signal?: AbortSignal) => Promise<T>) {
    this.#load = load;
  }

  get(signal?: AbortSignal): Promise<T> {
    if (!this.#value) {
      const value = this.#load(signal);
      this.#value = value;
      value.catch(() => {
        if (this.#value === value) this.#value = undefined;
      });
    }
    return this.#value;
  }

  refresh(signal?: AbortSignal): Promise<T> {
    this.#value = undefined;
    return this.get(signal);
  }
}

class CachedMap<K, T> {
  readonly #load: (key: K, signal?: AbortSignal) => Promise<T>;
  readonly #entries = new Map<K, Cached<T>>();

  constructor(load: (key: K, signal?: AbortSignal) => Promise<T>) {
    this.#load = load;
  }

  #entry(key: K): Cached<T> {
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = new Cached((signal) => this.#load(key, signal));
      this.#entries.set(key, entry);
    }
    return entry;
  }

  get(key: K, signal?: AbortSignal): Promise<T> {
    return this.#entry(key).get(signal);
  }

  refresh(key: K, signal?: AbortSignal): Promise<T> {
    return this.#entry(key).refresh(signal);
  }
}

export type Lookup<T> = {
  get(signal?: AbortSignal): Promise<T>;
  refresh(signal?: AbortSignal): Promise<T>;
};

export type KeyedLookup<K, T> = {
  get(key: K, signal?: AbortSignal): Promise<T>;
  refresh(key: K, signal?: AbortSignal): Promise<T>;
};

/** Справочники пространства: живут всё время работы процесса, при промахе поиска их перечитывают. */
export class Directory {
  readonly me: Lookup<Member>;
  readonly workspace: Lookup<Workspace>;
  readonly members: Lookup<Member[]>;
  readonly tags: Lookup<Tag[]>;
  readonly projects: Lookup<Project[]>;
  readonly boards: KeyedLookup<number, Board[]>;
  readonly columns: KeyedLookup<number, Column[]>;

  constructor(api: WeeekApi) {
    this.me = new Cached((signal) => api.me(signal));
    this.workspace = new Cached((signal) => api.workspace(signal));
    this.members = new Cached((signal) => api.members(signal));
    this.tags = new Cached((signal) => api.tags(signal));
    this.projects = new Cached((signal) => api.projects(signal));
    this.boards = new CachedMap((projectId: number, signal) => api.boards(projectId, signal));
    this.columns = new CachedMap((boardId: number, signal) => api.columns(boardId, signal));
  }

  async allBoards(signal?: AbortSignal, refresh = false): Promise<Board[]> {
    const projects = refresh ? await this.projects.refresh(signal) : await this.projects.get(signal);
    const boards = await Promise.all(
      projects.map((project) => (refresh ? this.boards.refresh(project.id, signal) : this.boards.get(project.id, signal))),
    );
    return boards.flat();
  }
}
