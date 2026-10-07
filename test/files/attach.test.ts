import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkAttachment } from '../../src/files/attach.ts';

describe('checkAttachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-weeek-attach-'));
  after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(project, 'shots'), { recursive: true });
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(home, 'Pictures'), { recursive: true });
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(project, 'shots', 'screen.png'), 'png');
  await writeFile(join(project, 'notes.MD'), '# notes');
  await writeFile(join(project, '.env'), 'TOKEN=secret');
  await writeFile(join(project, '.git', 'config'), '[core]');
  await writeFile(join(project, 'big.bin'), Buffer.alloc(2048));
  await writeFile(join(home, '.ssh', 'id_rsa'), 'key');
  await writeFile(join(home, 'Pictures', 'cat.jpg'), 'jpg');
  await symlink(join(home, '.ssh', 'id_rsa'), join(project, 'innocent.png'));
  await symlink(join(project, '.env'), join(project, 'env-link.txt'));
  await symlink(join(home, 'Pictures'), join(project, 'pictures'));

  const policy = { roots: [project, join(home, 'Pictures')], baseDir: project, homeDir: home };

  it('accepts files inside the allowed folders and detects the type', async () => {
    assert.deepEqual(await checkAttachment('shots/screen.png', policy), {
      path: 'shots/screen.png',
      realPath: join(project, 'shots', 'screen.png'),
      name: 'screen.png',
      size: 3,
      type: 'image/png',
    });
    assert.equal((await checkAttachment(join(project, 'notes.MD'), policy)).type, 'text/markdown');
    assert.equal((await checkAttachment('~/Pictures/cat.jpg', policy)).type, 'image/jpeg');
  });

  it('follows a symlink that stays inside an allowed folder', async () => {
    assert.equal((await checkAttachment('pictures/cat.jpg', policy)).realPath, join(home, 'Pictures', 'cat.jpg'));
  });

  it('refuses files outside the allowed folders, also through symlinks and ..', async () => {
    await assert.rejects(checkAttachment('innocent.png', policy), /outside the allowed folders/);
    await assert.rejects(checkAttachment('../home/.ssh/id_rsa', policy), /outside the allowed folders/);
    await assert.rejects(checkAttachment('~/.ssh/id_rsa', policy), /outside the allowed folders/);
    await assert.rejects(checkAttachment('/etc/hostname', policy), /outside the allowed folders/);
  });

  it('refuses hidden files and folders, also through symlinks', async () => {
    await assert.rejects(checkAttachment('.env', policy), /hidden file/);
    await assert.rejects(checkAttachment('.git/config', policy), /hidden file/);
    await assert.rejects(checkAttachment('env-link.txt', policy), /hidden file/);
  });

  it('refuses folders, missing files and files over the limit', async () => {
    await assert.rejects(checkAttachment('shots', policy), /not a regular file/);
    await assert.rejects(checkAttachment('nope.png', policy), /File not found: nope\.png/);
    await assert.rejects(checkAttachment('big.bin', { ...policy, maxBytes: 1024 }), /"big\.bin" is 2 KB; the limit is 1 KB per file\./);
    await assert.rejects(checkAttachment('  ', policy), /path is empty/);
  });

  it('refuses everything when no roots exist', async () => {
    await assert.rejects(checkAttachment('notes.MD', { ...policy, roots: [join(root, 'missing')] }), /outside the allowed folders/);
  });
});
