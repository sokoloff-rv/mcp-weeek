import type { FetchLike } from '../../src/weeek/client.ts';

export const BASE_URL = 'https://api.weeek.net/public/v1';

export type FakeRequest = {
  method: string;
  url: URL;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
  form: FormData | undefined;
  init: RequestInit;
};

type Reply = Response | object | undefined;
type Handler = (request: FakeRequest) => Reply | Promise<Reply>;

type Route = {
  method: string;
  path: string | RegExp;
  handler: Handler;
  remaining: number;
};

export class FakeFetch {
  readonly calls: FakeRequest[] = [];
  readonly #routes: Route[] = [];
  readonly #fallbacks: Route[] = [];

  /** Маршрут теста: проверяется раньше маршрутов по умолчанию, в порядке добавления. */
  on(method: string, path: string | RegExp, handler: Handler | object, options: { times?: number } = {}): this {
    this.#routes.push(route(method, path, handler, options.times));
    return this;
  }

  /** Маршрут по умолчанию: срабатывает, только если ни один маршрут теста не подошёл. */
  fallback(method: string, path: string | RegExp, handler: Handler | object): this {
    this.#fallbacks.push(route(method, path, handler, undefined));
    return this;
  }

  callsTo(method: string, path: string | RegExp): FakeRequest[] {
    return this.calls.filter((call) => call.method === method && matches(path, call.path));
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const request: FakeRequest = {
      method,
      url,
      path: url.origin === new URL(BASE_URL).origin ? url.pathname.replace(/^\/public\/v1/, '') : url.href.split('?')[0] ?? '',
      query: url.searchParams,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      form: init.body instanceof FormData ? init.body : undefined,
      init,
    };
    this.calls.push(request);
    const fits = (candidate: Route) => candidate.method === method && candidate.remaining > 0 && matches(candidate.path, request.path);
    const found = this.#routes.find(fits) ?? this.#fallbacks.find(fits);
    if (!found) throw new Error(`Unexpected request: ${method} ${url.href}`);
    found.remaining -= 1;
    const reply = await found.handler(request);
    if (reply instanceof Response) return reply;
    return json(reply ?? { success: true });
  };
}

function route(method: string, path: string | RegExp, handler: Handler | object, times: number | undefined): Route {
  const reply = typeof handler === 'function' ? (handler as Handler) : () => handler;
  return { method, path, handler: reply, remaining: times ?? Infinity };
}

function matches(pattern: string | RegExp, path: string): boolean {
  return typeof pattern === 'string' ? pattern === path : pattern.test(path);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export function empty(status = 204): Response {
  return new Response(null, { status });
}
