import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { safeFileName } from '../../src/files/download.ts';
import { json } from '../helpers/fake-fetch.ts';
import { ALPHA_CONFIG, createHarness, ME, task } from '../helpers/harness.ts';

const SIGNED = 'https://api.weeek.net/ws/100/files/f-1?expires=1&signature=abc';
const STORAGE = 'https://prod-private.s3.ru-1.storage.selcloud.ru/storage/x/f.png?X-Amz-Signature=zzz';

describe('weeek_attach_files', () => {
  it('uploads allowed files in one multipart request', async () => {
    const harness = await createHarness({ files: { 'shots/a.png': 'png-a', 'b.txt': 'text' } });
    harness.fake.on('GET', '/tm/tasks/500', { task: task() }).on('POST', '/tm/tasks/500/attachments', (request) => ({
      success: true,
      data: (request.form?.getAll('files[]') as File[]).map((file, index) => ({
        id: `f-${index}`,
        name: file.name,
        size: file.size,
        url: '',
        createdAt: '',
        creatorId: ME.id,
      })),
    }));
    const text = await harness.ok('weeek_attach_files', { id: 500, paths: ['shots/a.png', join(harness.dir, 'b.txt'), 'shots/a.png'] });
    assert.equal(text, 'Attached to #500 "Задача": a.png (5 B, id f-0), b.txt (4 B, id f-1).');
    const form = harness.fake.callsTo('POST', '/tm/tasks/500/attachments')[0]?.form;
    const files = form?.getAll('files[]') as File[];
    assert.deepEqual(files.map((file) => [file.name, file.type]), [['a.png', 'image/png'], ['b.txt', 'text/plain']]);
    assert.equal(await files[0]?.text(), 'png-a');
  });

  it('refuses forbidden paths before calling Weeek', async () => {
    const harness = await createHarness({ files: { '.env': 'SECRET=1' } });
    assert.match(await harness.fail('weeek_attach_files', { id: 500, paths: ['.env'] }), /hidden file/);
    assert.match(await harness.fail('weeek_attach_files', { id: 500, paths: ['/etc/passwd'] }), /outside the allowed folders/);
    assert.equal(harness.fake.callsTo('POST', /attachments/).length, 0);
  });

  it('needs a project config with attachRoots', async () => {
    const harness = await createHarness({ config: null });
    assert.match(await harness.fail('weeek_attach_files', { id: 500, paths: ['a.png'] }), /needs a \.weeek\.json with "attachRoots"/);
  });

  it('allows extra roots from the config', async () => {
    const harness = await createHarness({ config: { ...ALPHA_CONFIG, attachRoots: ['~/shots'] }, files: { 'x.png': 'x' } });
    assert.match(await harness.fail('weeek_attach_files', { id: 500, paths: ['x.png'] }), /outside the allowed folders \(.*\/shots\)/);
  });

  it('treats an upload that failed with 502 but landed in Weeek as done', async () => {
    const harness = await createHarness({ files: { 'a.png': 'png' } });
    harness.fake
      .on('GET', '/tm/tasks/500', { task: task() }, { times: 1 })
      .on('POST', '/tm/tasks/500/attachments', () => json({}, 502))
      .on('GET', '/tm/tasks/500', {
        task: task({ attachments: [{ id: 'f-9', name: 'a.png', size: 3, url: '', createdAt: '2026-10-08T12:00:01Z', creatorId: ME.id }] }),
      });
    assert.equal(await harness.ok('weeek_attach_files', { id: 500, paths: ['a.png'] }), 'Attached to #500 "Задача": a.png (3 B, id f-9).');
    assert.equal(harness.fake.callsTo('POST', /attachments/).length, 1);
  });

  it('says what was not attached when the upload really failed', async () => {
    const harness = await createHarness({ files: { 'a.png': 'png' } });
    harness.fake.on('GET', '/tm/tasks/500', { task: task() }).on('POST', '/tm/tasks/500/attachments', () => json({}, 500));
    assert.match(await harness.fail('weeek_attach_files', { id: 500, paths: ['a.png'] }), /Not attached: a\.png\. It is safe to retry/);
  });
});

describe('weeek_get_attachment', () => {
  it('downloads through the storage redirect without the token', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/ws/attachments/f-1', { success: true, data: { id: 'f-1', name: '../Скрин экрана.png', size: 4, url: SIGNED } })
      .on('GET', '/ws/100/files/f-1', () => new Response(null, { status: 303, headers: { Location: STORAGE } }))
      .on('GET', 'https://prod-private.s3.ru-1.storage.selcloud.ru/storage/x/f.png', () => new Response('data'));
    const text = await harness.ok('weeek_get_attachment', { id: 'f-1' });
    const saved = join(harness.downloadDir, 'f-1', '_Скрин экрана.png');
    assert.equal(text, `Saved "../Скрин экрана.png" (4 B) to ${saved}`);
    assert.equal(await readFile(saved, 'utf8'), 'data');
    const downloads = harness.fake.calls.filter((call) => !call.url.pathname.startsWith('/public/v1'));
    assert.equal(downloads.length, 2);
    for (const call of downloads) {
      assert.equal(call.headers.get('authorization'), null);
      assert.equal(call.init.redirect, 'manual');
    }
    assert.ok(harness.log.lines.every((line) => !line.includes('signature=abc')));
  });

  it('refuses redirects to hosts outside Weeek storage', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/ws/attachments/f-1', { success: true, data: { id: 'f-1', name: 'a.png', size: 1, url: SIGNED } })
      .on('GET', '/ws/100/files/f-1', () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/steal' } }));
    assert.match(await harness.fail('weeek_get_attachment', { id: 'f-1' }), /Refusing to download from https:\/\/evil\.example/);
  });

  it('refuses plain http and oversized files', async () => {
    const harness = await createHarness();
    harness.fake
      .on('GET', '/ws/attachments/f-1', { success: true, data: { id: 'f-1', name: 'a.png', size: 1, url: 'http://api.weeek.net/ws/100/files/f-1' } })
      .on('GET', '/ws/attachments/f-2', { success: true, data: { id: 'f-2', name: 'a.png', size: 1, url: SIGNED.replace('f-1', 'f-2') } })
      .on('GET', '/ws/100/files/f-2', () => new Response('x', { headers: { 'Content-Length': String(500 * 1024 * 1024) } }));
    assert.match(await harness.fail('weeek_get_attachment', { id: 'f-1' }), /Refusing to download from http:/);
    assert.match(await harness.fail('weeek_get_attachment', { id: 'f-2' }), /download limit/);
  });

  it('validates the id', async () => {
    const harness = await createHarness();
    assert.match(await harness.fail('weeek_get_attachment', { id: '../../etc' }), /must be an attachment id/);
  });
});

describe('safeFileName', () => {
  it('keeps names readable but harmless', () => {
    assert.equal(safeFileName('отчёт.pdf'), 'отчёт.pdf');
    assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd');
    assert.equal(safeFileName('...'), 'attachment');
    assert.equal(safeFileName('a:b*c?.png'), 'a_b_c_.png');
    assert.equal(safeFileName(`${'x'.repeat(300)}.png`).length, 150);
    assert.ok(safeFileName(`${'x'.repeat(300)}.png`).endsWith('.png'));
  });
});
