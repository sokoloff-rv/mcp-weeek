import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UserError } from '../../src/errors.ts';
import { WeeekClient, WeeekError, type ClientOptions } from '../../src/weeek/client.ts';
import { BASE_URL, empty, FakeFetch, json } from '../helpers/fake-fetch.ts';
import { captureLogger } from '../helpers/log.ts';

const TOKEN = 'test-token-0123456789';

function createClient(fake: FakeFetch, overrides: Partial<ClientOptions> = {}) {
  const log = captureLogger([TOKEN]);
  const sleeps: number[] = [];
  const client = new WeeekClient({
    token: TOKEN,
    baseUrl: BASE_URL,
    log,
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  });
  return { client, log, sleeps };
}

describe('WeeekClient: requests', () => {
  it('sends the bearer token, JSON body and query parameters', async () => {
    const fake = new FakeFetch().on('POST', '/tm/tasks', { success: true, task: { id: 1 } });
    const { client } = createClient(fake);
    const result = await client.request<{ task: { id: number } }>('POST', '/tm/tasks', {
      body: { title: 'A' },
      query: { completed: false, perPage: 100, skip: undefined, none: null },
    });
    assert.deepEqual(result, { success: true, task: { id: 1 } });
    const [call] = fake.calls;
    assert.equal(call?.headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(call?.headers.get('content-type'), 'application/json');
    assert.deepEqual(call?.body, { title: 'A' });
    assert.equal(call?.url.search, '?completed=0&perPage=100');
    assert.equal(call?.init.redirect, 'error');
  });

  it('treats an empty body as success', async () => {
    const fake = new FakeFetch().on('DELETE', '/tm/tasks/1/comments/2', () => empty());
    const { client } = createClient(fake);
    assert.deepEqual(await client.delete('/tm/tasks/1/comments/2'), {});
  });

  it('logs requests without the token', async () => {
    const fake = new FakeFetch().on('GET', '/ws', { success: true });
    const { client, log } = createClient(fake, { log: captureLogger([TOKEN]) });
    await client.get('/ws');
    assert.ok(log.lines.every((line) => !line.includes(TOKEN)));
  });

  it('refuses to send anything when the environment has problems', async () => {
    const fake = new FakeFetch();
    const { client } = createClient(fake, { problems: ['WEEEK_TOKEN is not set.'] });
    await assert.rejects(client.get('/ws'), (error: unknown) => error instanceof UserError && /WEEEK_TOKEN/.test(error.message));
    assert.equal(fake.calls.length, 0);
  });
});

describe('WeeekClient: errors', () => {
  async function failWith(status: number, body: unknown): Promise<WeeekError> {
    const fake = new FakeFetch().on('POST', '/x', () => json(body, status));
    const { client } = createClient(fake);
    try {
      await client.post('/x', {});
    } catch (error) {
      assert.ok(error instanceof WeeekError);
      return error;
    }
    assert.fail('expected an error');
  }

  it('explains 401', async () => {
    const error = await failWith(401, { success: false, message: 'Unauthenticated.' });
    assert.match(error.message, /rejected the token \(401\).*WEEEK_TOKEN/);
  });

  it('lists failed fields for 422', async () => {
    const error = await failWith(422, { success: false, errors: { boardColumnId: ['The field is required.'], 'tags.0': ['Invalid.'] } });
    assert.equal(error.message, 'Weeek rejected the request (422): boardColumnId: The field is required.; tags.0: Invalid. (POST /x).');
  });

  it('recognises "Model not found" answered with 400', async () => {
    const error = await failWith(400, { success: false, code: 1000001, message: 'Model not found' });
    assert.match(error.message, /^Not found \(400: Model not found\)\. Check the id/);
  });

  it('treats success: false with status 200 as an error', async () => {
    const error = await failWith(200, { success: false, message: 'Something went wrong' });
    assert.match(error.message, /Something went wrong/);
  });

  it('marks 5xx and 429 as transient', async () => {
    assert.equal((await failWith(502, {})).transient, true);
    assert.equal((await failWith(429, {})).transient, true);
    assert.equal((await failWith(403, {})).transient, false);
  });

  it('rejects a non-JSON success response', async () => {
    const fake = new FakeFetch().on('GET', '/ws', () => new Response('<html>', { status: 200 }));
    const { client } = createClient(fake);
    await assert.rejects(client.get('/ws'), /not JSON/);
  });
});

describe('WeeekClient: retries', () => {
  it('retries idempotent requests on 5xx with growing pauses', async () => {
    const fake = new FakeFetch()
      .on('GET', '/ws', () => json({}, 502), { times: 2 })
      .on('GET', '/ws', { success: true, workspace: { id: 1 } });
    const { client, sleeps } = createClient(fake, { retryDelayMs: 100 });
    assert.deepEqual(await client.get('/ws'), { success: true, workspace: { id: 1 } });
    assert.equal(fake.calls.length, 3);
    assert.deepEqual(sleeps, [100, 200]);
  });

  it('gives up after the last attempt', async () => {
    const fake = new FakeFetch().on('GET', '/ws', () => json({}, 503));
    const { client } = createClient(fake);
    await assert.rejects(client.get('/ws'), /server error \(503\)/);
    assert.equal(fake.calls.length, 3);
  });

  it('does not retry POST unless asked', async () => {
    const fake = new FakeFetch().on('POST', '/tm/tasks', () => json({}, 502));
    const { client } = createClient(fake);
    await assert.rejects(client.post('/tm/tasks', { title: 'A' }));
    assert.equal(fake.calls.length, 1);
  });

  it('retries POST marked as idempotent', async () => {
    const fake = new FakeFetch()
      .on('POST', '/tm/tasks/1/board-column', () => json({}, 500), { times: 1 })
      .on('POST', '/tm/tasks/1/board-column', { success: true });
    const { client } = createClient(fake);
    await client.post('/tm/tasks/1/board-column', { boardColumnId: 2 }, { retry: true });
    assert.equal(fake.calls.length, 2);
  });

  it('does not retry client errors', async () => {
    const fake = new FakeFetch().on('GET', '/tm/tasks/1', () => json({ message: 'Record not found' }, 404));
    const { client } = createClient(fake);
    await assert.rejects(client.get('/tm/tasks/1'), /Not found/);
    assert.equal(fake.calls.length, 1);
  });

  it('turns network failures and timeouts into transient errors', async () => {
    const fake = new FakeFetch().on('GET', '/ws', () => {
      throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
    });
    const { client } = createClient(fake, { attempts: 1 });
    await assert.rejects(client.get('/ws'), (error: unknown) => {
      assert.ok(error instanceof WeeekError);
      assert.equal(error.transient, true);
      assert.match(error.message, /Network error.*fetch failed \(ECONNRESET\)/);
      return true;
    });

    const hanging = new FakeFetch().on('GET', '/ws', (request) =>
      new Promise((_resolve, reject) => request.init.signal?.addEventListener('abort', () => reject(request.init.signal?.reason))),
    );
    const slow = createClient(hanging, { attempts: 1, timeoutMs: 20 });
    await assert.rejects(slow.client.get('/ws'), /did not respond within 0\.02 s/);
  });

  it('stops immediately when the caller cancels', async () => {
    const controller = new AbortController();
    const fake = new FakeFetch().on('GET', '/ws', () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const { client } = createClient(fake);
    await assert.rejects(client.get('/ws', {}, controller.signal), { name: 'AbortError' });
    assert.equal(fake.calls.length, 1);
  });
});
