import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BASE_URL, readEnv } from '../../src/config/env.ts';

describe('readEnv', () => {
  it('reads the token and defaults', () => {
    const env = readEnv({ WEEEK_TOKEN: ' secret ' });
    assert.deepEqual(env, {
      token: 'secret',
      baseUrl: DEFAULT_BASE_URL,
      readOnly: false,
      debug: false,
      configPath: undefined,
      problems: [],
    });
  });

  it('reports a missing token', () => {
    assert.match(readEnv({}).problems.join(), /WEEEK_TOKEN is not set/);
  });

  it('parses flags and the config path', () => {
    const env = readEnv({ WEEEK_TOKEN: 't', WEEEK_READ_ONLY: '1', WEEEK_DEBUG: 'true', WEEEK_CONFIG: '/p/.weeek.json' });
    assert.equal(env.readOnly, true);
    assert.equal(env.debug, true);
    assert.equal(env.configPath, '/p/.weeek.json');
    assert.equal(readEnv({ WEEEK_TOKEN: 't', WEEEK_READ_ONLY: '0' }).readOnly, false);
  });

  it('accepts another path on api.weeek.net and strips the trailing slash', () => {
    const env = readEnv({ WEEEK_TOKEN: 't', WEEEK_BASE_URL: 'https://api.weeek.net/public/v2/' });
    assert.equal(env.baseUrl, 'https://api.weeek.net/public/v2');
    assert.deepEqual(env.problems, []);
  });

  for (const url of [
    'http://api.weeek.net/public/v1',
    'https://evil.example/public/v1',
    'https://api.weeek.net.evil.example/',
    'https://api.weeek.net:8443/public/v1',
    'https://user:pass@api.weeek.net/public/v1',
    'not a url',
  ]) {
    it(`refuses WEEEK_BASE_URL=${url}`, () => {
      assert.match(readEnv({ WEEEK_TOKEN: 't', WEEEK_BASE_URL: url }).problems.join(), /must be an https URL on api\.weeek\.net/);
    });
  }
});
