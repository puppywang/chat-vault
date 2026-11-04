import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activityOf, createActivityIndex } from '../src/pi-activity.js';

const SID = '19a728f5-f66f-4b74-9f2d-fe65dd982b9b';
const REQ = 'wfr_01a12ef7d69f7564936754d9514bef99';
const OTHER = 'wfr_90dd1dd4031b4507b704a2ec71ebcd43';
const entry = (at, req, chat, ...tools) => JSON.stringify({ type: 'message', timestamp: at, message: { role: 'assistant',
  content: tools.map(([name, p]) => ({ type: 'toolCall', name, arguments: p ? { path: p } : { command: 'ls' } })),
  chappie: { chatId: `v1/xxxx${chat}`, requestId: req } } });

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-pi-act-'));
  const dir = path.join(home, '.pi', 'agent', 'sessions', '--D--proj--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-12T07-13-48-159Z_${SID}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: SID, cwd: 'D:\\proj' }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'chappie 字样但不是 assistant' }] } }),
    entry('2026-10-12T07:17:17.751Z', `${REQ}/tf8z`, '5ean', ['read', 'a.swift']),
    entry('2026-10-12T07:20:00.000Z', `${REQ}/aj78`, '5ean', ['edit', 'a.swift'], ['bash']),
    entry('2026-10-12T08:33:42.000Z', OTHER, 'uGGu', ['read', 'b.md']),
  ].join('\n') + '\n');
  const idx = createActivityIndex({ homeDir: home, indexFile: path.join(home, 'index.json'), saveDelayMs: 0 });
  return { home, file, idx };
}

test('按 request_id 的 wfr 主体汇总：分支后缀合并、其他对话分开、非 assistant 行忽略', async () => {
  const { idx } = setup();
  const { activity, indexing } = await idx.query({ sessionIds: [SID], requestIds: [REQ, OTHER] });
  assert.equal(indexing, false);
  const mine = activity.find(a => a.requestId === REQ);
  assert.deepEqual({ calls: mine.calls, byTool: mine.byTool, files: mine.files, chat: mine.chatTail, first: mine.first, last: mine.last },
    { calls: 3, byTool: { read: 1, edit: 1, bash: 1 }, files: ['a.swift'], chat: '5ean', first: '2026-10-12T07:17:17.751Z', last: '2026-10-12T07:20:00.000Z' });
  assert.equal(activity.find(a => a.requestId === OTHER).calls, 1);
  assert.deepEqual((await idx.query({ sessionIds: [SID], requestIds: [OTHER] })).activity.map(a => a.requestId), [OTHER], '只回问到的请求');
  assert.equal(activityOf('{"type":"message","message":{"role":"user","content":"chappie"}}'), null);
});

test('增量：只读追加的部分（含跨块的半行）；文件被重写变小时从头重建；索引落盘后新实例接着用', async () => {
  const { home, file, idx } = setup();
  await idx.query({ sessionIds: [SID], requestIds: [REQ] });
  const line = entry('2026-10-12T08:39:46.000Z', `${REQ}/w21a`, '5ean', ['write', 'c.py']);
  fs.appendFileSync(file, line.slice(0, 40));               // 半行：还没写完
  let r = (await idx.query({ sessionIds: [SID], requestIds: [REQ] })).activity[0];
  assert.equal(r.calls, 3, '半行不计');
  fs.appendFileSync(file, line.slice(40) + '\n');
  r = (await idx.query({ sessionIds: [SID], requestIds: [REQ] })).activity[0];
  assert.equal(r.calls, 4);
  assert.deepEqual(r.files, ['a.swift', 'c.py']);
  assert.equal(r.last, '2026-10-12T08:39:46.000Z');
  await new Promise(resolve => setTimeout(resolve, 20));
  const again = createActivityIndex({ homeDir: home, indexFile: path.join(home, 'index.json'), saveDelayMs: 0 });
  assert.equal((await again.query({ sessionIds: [SID], requestIds: [REQ] })).activity[0].calls, 4, '从落盘的索引接着用，不重复计数');
  fs.writeFileSync(file, entry('2026-10-12T09:00:00.000Z', `${REQ}/x`, '5ean', ['bash']) + '\n');
  assert.equal((await again.query({ sessionIds: [SID], requestIds: [REQ] })).activity[0].calls, 1, '文件变小：重建');
});
