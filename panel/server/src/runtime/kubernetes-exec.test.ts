import test from 'node:test';
import assert from 'node:assert/strict';
import { safeName, safeVolPath, tarSingleFile } from './kubernetes-exec.js';

test('safeName accepts normal basenames', () => {
  assert.equal(safeName('hello.txt'), true);
  assert.equal(safeName('微信 文件.zip'), true);
});

test('safeName rejects traversal and empty names', () => {
  assert.equal(safeName(''), false);
  assert.equal(safeName('../x'), false);
  assert.equal(safeName('a/b'), false);
  assert.equal(safeName('..'), false);
});

test('safeVolPath resolves paths under /config', () => {
  assert.equal(safeVolPath(''), '/config');
  assert.equal(safeVolPath('/Desktop'), '/config/Desktop');
  assert.equal(safeVolPath('a/./b'), '/config/a/b');
});

test('safeVolPath rejects parent traversal', () => {
  assert.throws(() => safeVolPath('../secret'), /路径不合法/);
});

test('tarSingleFile creates a tar archive containing the filename', () => {
  const tar = tarSingleFile('hello.txt', Buffer.from('abc'));
  assert.equal(tar.subarray(0, 9).toString('utf8'), 'hello.txt');
  assert.equal(tar.length % 512, 0);
});
