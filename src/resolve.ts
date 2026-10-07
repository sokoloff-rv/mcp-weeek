import type { LoadedConfig, ProjectConfig } from './config/project.ts';
import { UserError } from './errors.ts';
import type { Directory } from './weeek/directory.ts';
import { memberName, normalize, sameName } from './weeek/names.ts';
import type { Board, Column, Member, Project, Tag } from './weeek/types.ts';

export type Ref = string | number;

export class Resolver {
  readonly #directory: Directory;
  readonly #loaded: LoadedConfig;
  readonly #signal: AbortSignal | undefined;

  constructor(directory: Directory, loaded: LoadedConfig, signal?: AbortSignal) {
    this.#directory = directory;
    this.#loaded = loaded;
    this.#signal = signal;
  }

  get config(): ProjectConfig | undefined {
    return this.#loaded.status === 'ok' ? this.#loaded.config : undefined;
  }

  me(): Promise<Member> {
    return this.#directory.me.get(this.#signal);
  }

  async board(ref?: Ref): Promise<Board> {
    if (isBlank(ref)) return this.#defaultBoard();
    const id = asId(ref);
    if (id !== undefined) return this.#findBoard((board) => board.id === id, `Board ${id}`);
    const name = String(ref).trim();
    const configured = this.config?.boards.find((board) => board.alias !== undefined && sameName(board.alias, name));
    if (configured) return this.#findBoard((board) => board.id === configured.id, `Board ${configured.id} (alias "${name}")`);
    return this.#findBoard((board) => sameName(board.name, name), `Board "${name}"`);
  }

  boardAlias(board: Board): string | undefined {
    return this.config?.boards.find((configured) => configured.id === board.id)?.alias;
  }

  async columns(board: Board): Promise<Column[]> {
    return this.#directory.columns.get(board.id, this.#signal);
  }

  async column(board: Board, ref: Ref): Promise<Column> {
    const targets = [...new Set([this.#columnTarget(ref), typeof ref === 'string' ? ref.trim() : ref])];
    const matchesTarget = (column: Column, target: string | number) =>
      typeof target === 'number' ? column.id === target : sameName(column.name, target);
    const find = (columns: Column[]) =>
      targets.map((target) => columns.filter((column) => matchesTarget(column, target))).find((found) => found.length > 0) ?? [];
    let columns = await this.columns(board);
    let found = find(columns);
    if (found.length === 0) {
      columns = await this.#directory.columns.refresh(board.id, this.#signal);
      found = find(columns);
    }
    if (found.length === 1 && found[0]) return found[0];
    const problem = found.length > 1 ? `is ambiguous on board "${board.name}"` : `not found on board "${board.name}" (${board.id})`;
    throw new UserError(`Column "${ref}" ${problem}. Columns: ${this.describeColumns(columns)}.`);
  }

  async defaultColumn(board: Board): Promise<Column> {
    const configured = this.config?.defaultColumn;
    if (configured !== undefined) {
      try {
        return await this.column(board, configured);
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
      }
    }
    const [first] = await this.columns(board);
    if (!first) throw new UserError(`Board "${board.name}" (${board.id}) has no columns.`);
    return first;
  }

  columnAlias(column: Column): string | undefined {
    const entries = Object.entries(this.config?.columns ?? {});
    return entries.find(([, target]) => (typeof target === 'number' ? target === column.id : sameName(target, column.name)))?.[0];
  }

  describeColumns(columns: Column[]): string {
    return columns.map((column) => this.columnLabel(column)).join(', ') || 'none';
  }

  columnLabel(column: Column): string {
    const alias = this.columnAlias(column);
    return `${column.name} (${column.id})${alias ? ` [${alias}]` : ''}`;
  }

  async project(ref?: Ref): Promise<Project> {
    if (isBlank(ref)) {
      const config = this.#configForDefaults('project');
      const projectId = config.projectId ?? (config.boards[0] ? (await this.board(config.boards[0].id)).projectId : undefined);
      if (projectId === undefined) throw new UserError('No project given and .weeek.json has neither "projectId" nor "boards". Pass project.');
      return this.project(projectId);
    }
    const id = asId(ref);
    const matches = (project: Project) => (id !== undefined ? project.id === id : sameName(project.title, String(ref)));
    let projects = await this.#directory.projects.get(this.#signal);
    let found = projects.filter(matches);
    if (found.length === 0) {
      projects = await this.#directory.projects.refresh(this.#signal);
      found = projects.filter(matches);
    }
    if (found.length === 1 && found[0]) return found[0];
    const list = projects.map((project) => `${project.title} (${project.id})`).join(', ');
    throw new UserError(`Project "${ref}" ${found.length > 1 ? 'is ambiguous' : 'not found'}. Projects: ${list || 'none'}.`);
  }

  async member(ref: string): Promise<Member> {
    const query = ref.trim();
    if (normalize(query) === 'me') return this.me();
    const matches = (member: Member) =>
      member.id === query ||
      (member.email !== null && sameName(member.email, query)) ||
      memberNames(member).some((name) => sameName(name, query));
    let members = await this.#directory.members.get(this.#signal);
    let found = members.filter(matches);
    if (found.length === 0) {
      members = await this.#directory.members.refresh(this.#signal);
      found = members.filter(matches);
    }
    if (found.length === 1 && found[0]) return found[0];
    const list = members.map((member) => `${memberName(member)} (${member.id})`).join(', ');
    throw new UserError(`Member "${ref}" ${found.length > 1 ? 'is ambiguous' : 'not found'}. Members: ${list || 'none'}.`);
  }

  async tags(refs: readonly Ref[]): Promise<Tag[]> {
    let tags = await this.#directory.tags.get(this.#signal);
    const lookup = (ref: Ref) => {
      const id = asId(ref);
      return tags.filter((tag) => (id !== undefined ? tag.id === id : sameName(tag.title, String(ref))));
    };
    if (refs.some((ref) => lookup(ref).length === 0)) tags = await this.#directory.tags.refresh(this.#signal);
    return refs.map((ref) => {
      const found = lookup(ref);
      if (found.length === 1 && found[0]) return found[0];
      if (found.length > 1) {
        throw new UserError(`Tag "${ref}" is ambiguous: ${found.map((tag) => `${tag.title} (${tag.id})`).join(', ')}. Pass the tag id.`);
      }
      const list = tags.map((tag) => tag.title).join(', ');
      throw new UserError(`Tag "${ref}" not found. Existing tags: ${list || 'none'}. This server does not create tags: add it in Weeek first.`);
    });
  }

  async tagTitles(ids: readonly number[]): Promise<string[]> {
    if (ids.length === 0) return [];
    let tags = await this.#directory.tags.get(this.#signal);
    if (ids.some((id) => !tags.some((tag) => tag.id === id))) tags = await this.#directory.tags.refresh(this.#signal);
    return ids.map((id) => tags.find((tag) => tag.id === id)?.title ?? `#${id}`);
  }

  async memberNames(ids: readonly string[]): Promise<Map<string, string>> {
    const members = await this.#directory.members.get(this.#signal);
    return new Map(ids.map((id) => [id, nameOf(members, id)]));
  }

  async #defaultBoard(): Promise<Board> {
    const config = this.#configForDefaults('board');
    const [first] = config.boards;
    if (first) return this.board(first.id);
    if (config.projectId !== undefined) {
      const boards = await this.#directory.boards.get(config.projectId, this.#signal);
      if (boards.length === 1 && boards[0]) return boards[0];
      const list = boards.map((board) => `${board.name} (${board.id})`).join(', ');
      throw new UserError(`No board given and .weeek.json lists no "boards". Boards of project ${config.projectId}: ${list || 'none'}. Pass board.`);
    }
    throw new UserError('No board given and .weeek.json has neither "boards" nor "projectId". Pass board.');
  }

  async #findBoard(predicate: (board: Board) => boolean, what: string): Promise<Board> {
    const projectId = this.config?.projectId;
    if (projectId !== undefined) {
      const local = (await this.#directory.boards.get(projectId, this.#signal)).filter(predicate);
      if (local.length === 1 && local[0]) return local[0];
    }
    let boards = await this.#directory.allBoards(this.#signal);
    let found = boards.filter(predicate);
    if (found.length === 0) {
      boards = await this.#directory.allBoards(this.#signal, true);
      found = boards.filter(predicate);
    }
    if (found.length === 1 && found[0]) return found[0];
    if (found.length > 1) {
      throw new UserError(`${what} is ambiguous: ${found.map((board) => `${board.name} (${board.id}, project ${board.projectId})`).join(', ')}. Pass the board id.`);
    }
    throw new UserError(`${what} not found. Call weeek_context to see projects and boards.`);
  }

  #columnTarget(ref: Ref): string | number {
    const id = asId(ref);
    if (id !== undefined) return id;
    const name = String(ref).trim();
    const alias = Object.keys(this.config?.columns ?? {}).find((key) => sameName(key, name));
    return alias === undefined ? name : (this.config?.columns[alias] ?? name);
  }

  #configForDefaults(what: string): ProjectConfig {
    const loaded = this.#loaded;
    if (loaded.status === 'missing') {
      throw new UserError(
        `No ${what} given and no .weeek.json found (searched from ${loaded.searchedFrom} upwards). Pass ${what} explicitly; weeek_context lists projects and boards.`,
      );
    }
    if (loaded.status === 'invalid') {
      throw new UserError(`No ${what} given and ${loaded.path} is invalid: ${loaded.error}. Fix the file or pass ${what} explicitly.`);
    }
    return loaded.config;
  }
}

export function asId(ref: Ref | undefined): number | undefined {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref > 0 ? ref : undefined;
  if (typeof ref === 'string' && /^\s*\d+\s*$/.test(ref)) return Number(ref);
  return undefined;
}

function isBlank(ref: Ref | undefined): ref is undefined {
  return ref === undefined || (typeof ref === 'string' && ref.trim() === '');
}

function memberNames(member: Member): string[] {
  const { firstName, lastName } = member;
  return [firstName, lastName, firstName && lastName ? `${firstName} ${lastName}` : '', firstName && lastName ? `${lastName} ${firstName}` : '']
    .filter((name): name is string => Boolean(name));
}

function nameOf(members: readonly Member[], id: string): string {
  const member = members.find((candidate) => candidate.id === id);
  return member ? memberName(member) : id;
}
