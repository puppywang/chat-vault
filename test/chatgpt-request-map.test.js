import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequestMap, requestIdsOf } from '../src/chatgpt-request-map.js';
import { createActivityIndex } from '../src/pi-activity.js';

const CONV = '6acc890d-4fd8-83ec-a00a-472f2b5421c8';
const conv = (id, title, reqs) => ({ conversation_id: id, title, update_time: 1791740000,
  mapping: Object.fromEntries(reqs.map((r, i) => [`n${i}`, { message: { id: `m${i}`, metadata: { request_id: r } } }])) });

test('请求 ID → 对话：入库时记录（去掉分支后缀、忽略非 wfr 与非 /c/ 对话），落盘后可回读；已归档对话一次性回填', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-reqmap-'));
  assert.deepEqual(requestIdsOf(conv(CONV, 't', ['wfr_01A12EF7D69F7564936754D9514BEF99/mk1u', 'c8a1bf38-cf2c-4cdc-bcc2-f035d4643372'])),
    ['wfr_01a12ef7d69f7564936754d9514bef99']);
  const m = createRequestMap({ homeDir: home, saveDelayMs: 0 });
  assert.equal(m.record(conv(CONV, '实现 iPhone Duo 升级', ['wfr_01a12ef7d69f7564936754d9514bef99'])), 1);
  assert.equal(m.record(conv('dots-x', 'dots', ['wfr_aaaaaaaaaaaaaaaaaaaa'])), 0, 'dots/codex 不是 /c/ 对话');
  assert.deepEqual(m.lookup('wfr_01a12ef7d69f7564936754d9514bef99/tf8z'),
    { conversationId: CONV, title: '实现 iPhone Duo 升级', updatedAt: new Date(1791740000 * 1000).toISOString() });
  await new Promise(r => setTimeout(r, 20));
  const live = path.join(home, '.chat-vault', 'imports', 'chatgpt', 'live');
  fs.mkdirSync(live, { recursive: true });
  const other = '11111111-2222-4333-8444-df1008f4a5a6';
  fs.writeFileSync(path.join(live, `${other}.json`), JSON.stringify(conv(other, '旧对话', ['wfr_bbbbbbbbbbbbbbbbbbbbbbbb'])));
  fs.writeFileSync(path.join(live, 'not-a-conv.json'), '{');
  const again = createRequestMap({ homeDir: home, saveDelayMs: 0 });
  assert.equal(again.lookup('wfr_01a12ef7d69f7564936754d9514bef99').conversationId, CONV, '从落盘读回');
  await again.ensureBackfill();
  assert.equal(again.lookup('wfr_bbbbbbbbbbbbbbbbbbbbbbbb').title, '旧对话');
  assert.ok(again._map().backfilledAt, '只回填一次');
});

test('每个 pi 会话的最近驱动者：多个对话按最近活动倒序，带调用次数与最后时间', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-recent-'));
  const sid = '19a728f5-f66f-4b74-9f2d-fe65dd982b9b';
  const dir = path.join(home, '.pi', 'agent', 'sessions', '--D--p--'); fs.mkdirSync(dir, { recursive: true });
  const e = (at, req, tail, tool) => JSON.stringify({ type: 'message', timestamp: at, message: { role: 'assistant',
    content: [{ type: 'toolCall', name: tool, arguments: { path: 'x' } }], chappie: { chatId: `v1/abc${tail}`, requestId: req } } });
  fs.writeFileSync(path.join(dir, `x_${sid}.jsonl`), [
    e('2026-10-12T07:17:00Z', 'wfr_aaaaaaaaaaaaaaaaaaaa/1', '5ean', 'edit'), e('2026-10-12T08:39:00Z', 'wfr_aaaaaaaaaaaaaaaaaaaa/2', '5ean', 'bash'),
    e('2026-10-12T08:33:00Z', 'wfr_bbbbbbbbbbbbbbbbbbbb', 'uGGu', 'read')].join('\n') + '\n');
  const idx = createActivityIndex({ homeDir: home, indexFile: path.join(home, 'i.json'), saveDelayMs: 0 });
  const { bySession, indexing } = await idx.recent({ sessionIds: [sid], waitMs: 5000 });
  assert.equal(indexing, false);
  const r = bySession.get(sid);
  assert.equal(r.last, '2026-10-12T08:39:00Z');
  assert.deepEqual(r.recent.map(x => [x.requestId, x.chatTail, x.calls]), [['wfr_aaaaaaaaaaaaaaaaaaaa', '5ean', 2], ['wfr_bbbbbbbbbbbbbbbbbbbb', 'uGGu', 1]]);
});
