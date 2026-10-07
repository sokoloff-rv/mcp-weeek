import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UserError } from '../errors.ts';
import { formatSize } from '../format/task-view.ts';
import { mimeType } from './mime.ts';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type PreparedFile = { path: string; realPath: string; name: string; size: number; type: string };

export type AttachPolicy = { roots: readonly string[]; baseDir: string; homeDir: string; maxBytes?: number };

/**
 * Проверяет, что файл можно прикрепить: после разрешения симлинков он лежит внутри одной из разрешённых папок,
 * не скрыт и не больше лимита. Так текст задачи не уговорит агента отправить в Weeek ~/.ssh/id_rsa или .env.
 */
export async function checkAttachment(path: string, policy: AttachPolicy): Promise<PreparedFile> {
  const requested = path.trim();
  if (!requested) throw new UserError('Attachment path is empty.');
  const expanded = requested === '~' || requested.startsWith('~/') ? join(policy.homeDir, requested.slice(1)) : requested;
  const absolute = isAbsolute(expanded) ? expanded : resolve(policy.baseDir, expanded);

  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new UserError(`File not found: ${requested}`);
  }
  const roots = (await Promise.all(policy.roots.map((root) => realpath(root).catch(() => undefined)))).filter(
    (root): root is string => root !== undefined,
  );
  const root = roots.find((candidate) => isInside(real, candidate));
  if (!root) {
    throw new UserError(
      `"${requested}" is outside the allowed folders (${policy.roots.join(', ') || 'none'}). Only files inside attachRoots of .weeek.json can be attached.`,
    );
  }
  if (relative(root, real).split(sep).some((segment) => segment.startsWith('.'))) {
    throw new UserError(`"${requested}" is a hidden file or lies in a hidden folder; such files are never attached.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new UserError(`"${requested}" is not a regular file.`);
  const maxBytes = policy.maxBytes ?? MAX_ATTACHMENT_BYTES;
  if (info.size > maxBytes) {
    throw new UserError(`"${requested}" is ${formatSize(info.size)}; the limit is ${formatSize(maxBytes)} per file.`);
  }
  const name = basename(real);
  return { path: requested, realPath: real, name, size: info.size, type: mimeType(name) };
}

function isInside(child: string, root: string): boolean {
  const path = relative(root, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
