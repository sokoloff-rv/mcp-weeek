import { UserError } from '../errors.ts';
import { isObject } from '../json.ts';
import type { Logger } from '../log.ts';
import { deadline } from '../timeout.ts';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type Query = Record<string, string | number | boolean | null | undefined>;

export type RequestOptions = {
  query?: Query;
  body?: unknown;
  form?: FormData;
  retry?: boolean;
  signal?: AbortSignal | undefined;
};

export class WeeekError extends UserError {
  override name = 'WeeekError';
  readonly status: number | undefined;
  readonly transient: boolean;

  constructor(message: string, status: number | undefined, transient: boolean) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

export type ClientOptions = {
  token: string;
  baseUrl: string;
  problems?: readonly string[];
  log: Logger;
  fetch?: FetchLike;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const IDEMPOTENT_METHODS = new Set(['GET', 'PUT', 'DELETE']);
const NOT_FOUND_CODE = 1000001;

export class WeeekClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #problems: readonly string[];
  readonly #log: Logger;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.#token = options.token;
    this.#baseUrl = options.baseUrl;
    this.#problems = options.problems ?? [];
    this.#log = options.log;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#attempts = options.attempts ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, { query, signal });
  }

  post<T>(path: string, body?: unknown, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...options, body: body ?? {} });
  }

  put<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('PUT', path, { body, signal });
  }

  delete<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('DELETE', path, { body, signal });
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    if (this.#problems.length > 0) throw new UserError(this.#problems.join('\n'));
    const retry = options.retry ?? IDEMPOTENT_METHODS.has(method);
    const attempts = retry ? this.#attempts : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#send<T>(method, path, options);
      } catch (error) {
        const retriable = error instanceof WeeekError && error.transient && !options.signal?.aborted;
        if (!retriable || attempt >= attempts) throw error;
        this.#log.debug(`${method} ${path}: ${error.message} Retrying (${attempt + 1}/${attempts}).`);
        await this.#sleep(this.#retryDelayMs * attempt);
      }
    }
  }

  async #send<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = this.#url(path, options.query);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' };
    let body: RequestInit['body'];
    if (options.form) {
      body = options.form;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const timeout = deadline(this.#timeoutMs, options.signal);
    const label = `${method} ${path}`;
    const started = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, { method, headers, body, signal: timeout.signal, redirect: 'error' });
      text = await response.text();
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timeout.expired()) {
        throw new WeeekError(`Weeek did not respond within ${this.#timeoutMs / 1000} s (${label}).`, undefined, true);
      }
      throw new WeeekError(`Network error while calling Weeek (${label}): ${errorMessage(error)}`, undefined, true);
    } finally {
      timeout.clear();
    }
    this.#log.debug(`${label} → ${response.status} in ${Date.now() - started} ms`);
    const data = parseBody(text);
    if (!response.ok || (isObject(data) && data.success === false)) throw toWeeekError(label, response.status, data);
    if (data === INVALID_JSON) throw new WeeekError(`Weeek returned a response that is not JSON (${label}).`, response.status, false);
    return (data ?? {}) as T;
  }

  #url(path: string, query: Query = {}): string {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
    return url.toString();
  }
}

const INVALID_JSON = Symbol('invalid json');

function parseBody(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return INVALID_JSON;
  }
}

function toWeeekError(label: string, status: number, data: unknown): WeeekError {
  const body = isObject(data) ? data : {};
  const message = typeof body.message === 'string' ? body.message : '';
  const details = isObject(body.errors) ? formatFieldErrors(body.errors) : message;
  const suffix = ` (${label})`;
  if (status === 401) {
    return new WeeekError(`Weeek rejected the token (401). Check WEEEK_TOKEN: it may be revoked; a new one is created in Weeek → Settings → API${suffix}.`, status, false);
  }
  if (status === 403) {
    return new WeeekError(`Access denied (403): the token's user cannot access this object${suffix}.`, status, false);
  }
  if (status === 404 || body.code === NOT_FOUND_CODE) {
    return new WeeekError(`Not found (${status}${message ? `: ${message}` : ''}). Check the id${suffix}.`, status, false);
  }
  if (status === 422) {
    return new WeeekError(`Weeek rejected the request (422): ${details || 'validation failed'}${suffix}.`, status, false);
  }
  if (status === 429) {
    return new WeeekError(`Too many requests to Weeek (429). Wait a little and retry${suffix}.`, status, true);
  }
  if (status >= 500) {
    return new WeeekError(`Weeek server error (${status})${message ? `: ${message}` : ''}${suffix}.`, status, true);
  }
  return new WeeekError(`Weeek error (${status})${details ? `: ${details}` : ''}${suffix}.`, status, false);
}

function formatFieldErrors(errors: Record<string, unknown>): string {
  return Object.entries(errors)
    .map(([field, messages]) => `${field}: ${Array.isArray(messages) ? messages.join(' ') : String(messages)}`)
    .join('; ');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}
