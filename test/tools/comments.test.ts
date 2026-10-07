import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { empty, json } from '../helpers/fake-fetch.ts';
import { createHarness, ME } from '../helpers/harness.ts';

const NBSP = String.fromCharCode(0xa0);

function comment(overrides: Record<string, unknown> = {}) {
  return { id: 50, parentId: null, authorId: ME.id, markdown: 'text', createdAt: '2026-10-08T12:00:00Z', updatedAt: '', ...overrides };
}

describe('weeek_add_comment', () => {
  it('posts Markdown with nested lists flattened', async () => {
    const harness = await createHarness();
    harness.fake.on('POST', '/tm/tasks/500/comments', { comment: comment({ id: 61 }) });
    assert.equal(await harness.ok('weeek_add_comment', { id: 500, text: '  Итог:\n- a\n  - b\n' }), 'Comment #61 added to task #500.');
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/500/comments')[0]?.body, { markdown: `Итог:\n- a\n- ${NBSP.repeat(4)}◦ b` });
  });

  it('replies to a comment', async () => {
    const harness = await createHarness();
    harness.fake.on('POST', '/tm/tasks/500/comments', { comment: comment({ id: 62, parentId: 7 }) });
    assert.equal(await harness.ok('weeek_add_comment', { id: 500, text: 'Да', replyTo: 7 }), 'Comment #62 added to task #500 as a reply to #7.');
    assert.deepEqual(harness.fake.callsTo('POST', '/tm/tasks/500/comments')[0]?.body, { markdown: 'Да', parentId: 7 });
  });

  it('does not post twice when Weeek saved the comment despite an error', async () => {
    const harness = await createHarness();
    harness.fake
      .on('POST', '/tm/tasks/500/comments', () => json({}, 504))
      .on('GET', '/tm/tasks/500/comments', {
        comments: [comment({ id: 70, authorId: '7' }), comment({ id: 69 }), comment({ id: 1, createdAt: '2026-09-01T00:00:00Z' })],
        hasMore: false,
      });
    const text = await harness.ok('weeek_add_comment', { id: 500, text: 'Итог' });
    assert.match(text, /^Comment #69 added to task #500\.\nWeeek answered with an error, but the comment had been saved/);
    assert.equal(harness.fake.callsTo('POST', /comments/).length, 1);
  });

  it('says that retrying is safe when the comment is missing', async () => {
    const harness = await createHarness();
    harness.fake
      .on('POST', '/tm/tasks/500/comments', () => json({}, 500))
      .on('GET', '/tm/tasks/500/comments', { comments: [], hasMore: false });
    assert.match(await harness.fail('weeek_add_comment', { id: 500, text: 'Итог' }), /The comment was not added: checked the task\. It is safe to retry\./);
  });

  it('requires text', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_add_comment', { id: 500, text: ' ' }), /Parameter "text" is required/);
  });
});

describe('weeek_delete_comment', () => {
  it('deletes a comment of the token owner', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500/comments', { comments: [comment({ id: 50 })], hasMore: false })
      .on('DELETE', '/tm/tasks/500/comments/50', () => empty());
    assert.equal(await harness.ok('weeek_delete_comment', { id: 500, commentId: 50 }), 'Deleted comment #50 from task #500.');
  });

  it('never deletes comments of other people', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/500/comments', { comments: [comment({ id: 50, authorId: '7' })], hasMore: false });
    assert.equal(
      await harness.fail('weeek_delete_comment', { id: 500, commentId: 50 }),
      'Comment #50 was written by Анна Петрова. Only comments of the token owner (Agent) can be deleted.',
    );
    assert.equal(harness.fake.callsTo('DELETE', /comments/).length, 0);
  });

  it('reports a missing comment', async () => {
    const harness = await createHarness();
    harness.fake.on('GET', '/tm/tasks/500/comments', { comments: [], hasMore: false });
    assert.match(await harness.fail('weeek_delete_comment', { id: 500, commentId: 50 }), /Comment #50 not found on task #500/);
  });

  it('treats 404 after a retried DELETE as success when the comment is gone', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/tm/tasks/500/comments', { comments: [comment({ id: 50 })], hasMore: false }, { times: 1 })
      .on('GET', '/tm/tasks/500/comments', { comments: [], hasMore: false })
      .on('DELETE', '/tm/tasks/500/comments/50', () => json({}, 502), { times: 1 })
      .on('DELETE', '/tm/tasks/500/comments/50', () => json({ message: 'Record not found' }, 404));
    assert.equal(await harness.ok('weeek_delete_comment', { id: 500, commentId: 50 }), 'Deleted comment #50 from task #500.');
  });
});
