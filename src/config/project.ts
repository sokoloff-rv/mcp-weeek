import { stat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isObject } from '../json.ts';

export const CONFIG_FILE = '.weeek.json';

export type BoardConfig = { id: number; alias: string | undefined };

export type ProjectConfig = {
  workspaceId: number | undefined;
  projectId: number | undefined;
  boards: BoardConfig[];
  columns: Record<string, string | number>;
  defaultColumn: string | number | undefined;
  attachRoots: string[];
  conventions: string[];
};

export type LoadedConfig =
  | { status: 'missing'; searchedFrom: string }
  | { status: 'invalid'; path: string; error: string }
  | { status: 'ok'; path: string; dir: string; config: ProjectConfig; warnings: string[] };

const KNOWN_KEYS = new Set(['workspaceId', 'projectId', 'boards', 'columns', 'defaultColumn', 'attachRoots', 'conventions']);

export function parseProjectConfig(text: string, dir: string, homeDir: string): { config: ProjectConfig; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(raw)) throw new Error('the file must contain a JSON object');

  const errors: string[] = [];
  const warnings = Object.keys(raw)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `Unknown key "${key}" is ignored.`);

  const id = (key: string, value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    if (isPositiveInteger(value)) return value;
    errors.push(`"${key}" must be a positive integer`);
    return undefined;
  };

  const boards: BoardConfig[] = [];
  if (raw.boards !== undefined) {
    if (!Array.isArray(raw.boards)) errors.push('"boards" must be an array');
    else {
      raw.boards.forEach((board: unknown, index) => {
        if (isPositiveInteger(board)) boards.push({ id: board, alias: undefined });
        else if (isObject(board) && isPositiveInteger(board.id) && (board.alias === undefined || isNonEmptyString(board.alias))) {
          boards.push({ id: board.id, alias: board.alias?.trim() });
        } else errors.push(`"boards[${index}]" must be a board id or {"id": number, "alias"?: string}`);
      });
    }
  }

  const columns: Record<string, string | number> = {};
  if (raw.columns !== undefined) {
    if (!isObject(raw.columns)) errors.push('"columns" must be an object: {"alias": "column name or id"}');
    else {
      for (const [alias, target] of Object.entries(raw.columns)) {
        if (isNonEmptyString(target)) columns[alias] = target.trim();
        else if (isPositiveInteger(target)) columns[alias] = target;
        else errors.push(`"columns.${alias}" must be a column name or id`);
      }
    }
  }

  let defaultColumn: string | number | undefined;
  if (raw.defaultColumn !== undefined) {
    if (isNonEmptyString(raw.defaultColumn) || isPositiveInteger(raw.defaultColumn)) defaultColumn = raw.defaultColumn;
    else errors.push('"defaultColumn" must be a column alias, name or id');
  }

  const attachRoots = stringList('attachRoots', raw.attachRoots, errors)?.map((root) => resolveRoot(root, dir, homeDir)) ?? [dir];
  const conventions = stringList('conventions', raw.conventions, errors) ?? [];

  const config: ProjectConfig = {
    workspaceId: id('workspaceId', raw.workspaceId),
    projectId: id('projectId', raw.projectId),
    boards,
    columns,
    defaultColumn,
    attachRoots,
    conventions,
  };
  if (errors.length > 0) throw new Error(errors.join('; '));
  return { config, warnings };
}

function stringList(key: string, value: unknown, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (isNonEmptyString(value)) return [value];
  if (Array.isArray(value) && value.every(isNonEmptyString)) return value;
  errors.push(`"${key}" must be a string or an array of strings`);
  return undefined;
}

function resolveRoot(root: string, dir: string, homeDir: string): string {
  if (root === '~') return homeDir;
  if (root.startsWith('~/')) return join(homeDir, root.slice(2));
  return isAbsolute(root) ? resolve(root) : resolve(dir, root);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export type LoaderOptions = {
  cwd: () => string;
  explicitPath: string | undefined;
  homeDir: string;
};

export class ProjectConfigLoader {
  readonly #options: LoaderOptions;
  readonly #cache = new Map<string, { mtimeMs: number; size: number; result: LoadedConfig }>();

  constructor(options: LoaderOptions) {
    this.#options = options;
  }

  async load(): Promise<LoadedConfig> {
    const cwd = this.#options.cwd();
    const explicit = this.#options.explicitPath;
    const path = explicit ? resolve(cwd, explicit) : await findUp(cwd);
    if (!path) return { status: 'missing', searchedFrom: cwd };

    let info;
    try {
      info = await stat(path);
    } catch {
      return { status: 'invalid', path, error: 'WEEEK_CONFIG points to a file that does not exist' };
    }
    const cached = this.#cache.get(path);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.result;

    const dir = dirname(path);
    let result: LoadedConfig;
    try {
      const { config, warnings } = parseProjectConfig(await readFile(path, 'utf8'), dir, this.#options.homeDir);
      result = { status: 'ok', path, dir, config, warnings };
    } catch (error) {
      result = { status: 'invalid', path, error: error instanceof Error ? error.message : String(error) };
    }
    this.#cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, result });
    return result;
  }
}

async function findUp(start: string): Promise<string | undefined> {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILE);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // нет файла на этом уровне — идём выше
    }
    if (dirname(dir) === dir) return undefined;
  }
}
