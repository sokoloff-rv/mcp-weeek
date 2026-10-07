import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, createMasker } from '../src/log.ts';
import { captureLogger } from './helpers/log.ts';

const TOKEN = '0f9e8d7c-6b5a-4321-9876-fedcba012345';

describe('createMasker', () => {
  const mask = createMasker([TOKEN]);

  it('hides the token wherever it appears', () => {
    assert.equal(mask(`token=${TOKEN}; again ${TOKEN}`), 'token=***; again ***');
  });

  it('hides any bearer credentials', () => {
    assert.equal(mask('Authorization: Bearer abc.def-123'), 'Authorization: Bearer ***');
  });

  it('hides signatures in signed links but keeps the rest of the URL', () => {
    assert.equal(
      mask('GET https://api.weeek.net/ws/1/files/x?expires=1700000000&signature=deadbeef'),
      'GET https://api.weeek.net/ws/1/files/x?expires=1700000000&signature=***',
    );
    assert.equal(
      mask('https://s3.example/x.png?X-Amz-Credential=AKIA/2026&X-Amz-Signature=abc'),
      'https://s3.example/x.png?X-Amz-Credential=***&X-Amz-Signature=***',
    );
  });

  it('ignores too short secrets so that ordinary words are not masked', () => {
    assert.equal(createMasker(['a'])('banana'), 'banana');
  });
});

describe('createLogger', () => {
  it('masks every line', () => {
    const log = captureLogger([TOKEN]);
    log.error(`request failed with ${TOKEN}`);
    log.debug(`GET /ws Bearer ${TOKEN}`);
    assert.deepEqual(log.lines, [
      '[mcp-weeek] error: request failed with ***\n',
      '[mcp-weeek] debug: GET /ws Bearer ***\n',
    ]);
  });

  it('skips debug output when debug is off', () => {
    const lines: string[] = [];
    const log = createLogger({ secrets: [], debug: false, write: (line) => lines.push(line) });
    log.debug('hidden');
    log.info('shown');
    assert.deepEqual(lines, ['[mcp-weeek] info: shown\n']);
  });
});
