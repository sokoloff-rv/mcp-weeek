import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UserError } from '../errors.ts';
import { deadline } from '../timeout.ts';
import type { FetchLike } from '../weeek/client.ts';

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Ссылки на вложения ведут на api.weeek.net, а оттуда перенаправляют в хранилище Selectel. */
export function isStorageHost(hostname: string): boolean {
  return hostname === 'api.weeek.net' || hostname === 'storage.weeek.net' || hostname.endsWith('.storage.selcloud.ru');
}

export type DownloadOptions = {
  fetch: FetchLike;
  url: string;
  destination: string;
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
};

export async function downloadFile(options: DownloadOptions): Promise<number> {
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const timeout = deadline(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS, options.signal);
  const partial = `${options.destination}.part`;
  try {
    let url = new URL(options.url);
    for (let redirects = 0; ; redirects++) {
      if (url.protocol !== 'https:' || !isStorageHost(url.hostname)) {
        throw new UserError(`Refusing to download from ${url.protocol}//${url.host}: it is not a Weeek file storage.`);
      }
      const response = await options.fetch(url, { redirect: 'manual', signal: timeout.signal });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        if (redirects >= MAX_REDIRECTS) throw new UserError('Too many redirects while downloading the attachment.');
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new UserError(`Downloading the attachment failed with HTTP ${response.status}.`);
      }
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) {
        await response.body.cancel();
        throw new UserError(`The attachment is ${Math.ceil(declared / 1024 / 1024)} MB; the download limit is ${maxBytes / 1024 / 1024} MB.`);
      }
      await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
      let size = 0;
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
      source.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) source.destroy(new UserError(`The attachment is larger than the download limit of ${maxBytes / 1024 / 1024} MB.`));
      });
      await pipeline(source, createWriteStream(partial, { mode: 0o600 }));
      await rename(partial, options.destination);
      return size;
    }
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof UserError || options.signal?.aborted) throw error;
    if (timeout.expired()) throw new UserError('Downloading the attachment took too long.');
    throw new UserError(`Downloading the attachment failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    timeout.clear();
  }
}

export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, '_')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '');
  if (!cleaned) return 'attachment';
  if (cleaned.length <= 150) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 150 - extension.length) + extension;
}
