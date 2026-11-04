import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncChunks } from '../extensions/chatgpt-sync/sync-chunks.js';

const tab = (id = 7, url = 'https://chatgpt.com/c/x') => ({ tab: { id, url } });
const chunk = (index, data, total = 3, uploadId = 'u1') => ({ type: 'syncChunk', uploadId, index, total, data });

test('乱序到达也能按下标拼回，取走后释放', () => {
  const s = createSyncChunks();
  assert.deepEqual(s.accept(chunk(2, 'c'), tab()), { ok: true });
  assert.deepEqual(s.accept(chunk(0, 'a'), tab()), { ok: true });
  assert.deepEqual(s.accept(chunk(1, 'b'), tab()), { ok: true });
  assert.equal(s.take('u1', tab()), 'abc');
  assert.equal(s.size(), 0);
  assert.match(s.take('u1', tab()).error, /失效/, '同一上传不能取两次');
});

test('缺块时报错而不是拼出半截（稀疏数组空洞也要查出来）', () => {
  const s = createSyncChunks();
  s.accept(chunk(0, 'a'), tab());
  s.accept(chunk(2, 'c'), tab());
  assert.match(s.take('u1', tab()).error, /不完整/);
  assert.equal(s.size(), 0, '失败也释放暂存');
});

test('只收 ChatGPT 标签页；换标签页或改 total 的块被拒', () => {
  const s = createSyncChunks();
  assert.equal(s.accept(chunk(0, 'a'), tab(7, 'https://example.com/')).error, 'invalid_sender');
  assert.equal(s.accept(chunk(0, 'a'), {}).error, 'invalid_sender');
  assert.equal(s.accept(chunk(3, 'a'), tab()).error, 'invalid_chunk', '下标越界');
  assert.equal(s.accept({ ...chunk(0, 'a'), data: 1 }, tab()).error, 'invalid_chunk');
  s.accept(chunk(0, 'a'), tab(7));
  assert.equal(s.accept(chunk(1, 'b'), tab(8)).error, 'invalid_chunk', '别的标签页不能往里塞');
  assert.equal(s.accept(chunk(1, 'b', 4), tab(7)).error, 'invalid_chunk', 'total 不一致');
  assert.match(s.take('u1', tab(8)).error, /失效/, '别的标签页不能取走');
});

test('过期的半截上传在下次收块时清掉', () => {
  let clock = 0;
  const s = createSyncChunks({ ttlMs: 1000, now: () => clock });
  s.accept(chunk(0, 'a', 2, 'old'), tab());
  clock = 5000;
  s.accept(chunk(0, 'x', 1, 'new'), tab());
  assert.equal(s.size(), 1);
  assert.match(s.take('old', tab()).error, /失效/);
  assert.equal(s.take('new', tab()), 'x');
});
