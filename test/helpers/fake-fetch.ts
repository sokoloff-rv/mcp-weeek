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

  on(method: string, path: string | RegExp, handler: Handler | object, options: { times?: number } = {}): this {
    const reply = typeof handler === 'function' ? (handler as Handler) : () => handler;
    this.#routes.push({ method, path, handler: reply, remaining: options.times ?? Infinity });
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
    const route = this.#routes.find((candidate) => candidate.method === method && candidate.remaining > 0 && matches(candidate.path, request.path));
    if (!route) throw new Error(`Unexpected request: ${method} ${url.href}`);
    route.remaining -= 1;
    const reply = await route.handler(request);
    if (reply instanceof Response) return reply;
    return json(reply ?? { success: true });
  };
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
