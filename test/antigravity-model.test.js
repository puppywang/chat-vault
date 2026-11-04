import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { antigravityAdapter, trajectoryToSession } from '../src/adapters/antigravity.js';

// ---- 最小 protobuf 编码 ----
const varint = n => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
const tag = (field, wire) => varint(field * 8 + wire);
const bytes = (field, buf) => Buffer.concat([tag(field, 2), varint(buf.length), buf]);
const str = (field, s) => bytes(field, Buffer.from(s, 'utf8'));
const msg = (field, ...parts) => bytes(field, Buffer.concat(parts));
const num = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);

test('新格式 .db：gen_metadata 的 f2 步骤下标 + f1.f19 响应模型名落到对应步骤的消息上（灰度名 gemini-3.8-flash-exp-a）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-ag-'));
  const file = path.join(dir, 'c1.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE steps (idx INTEGER, step_type INTEGER, step_payload BLOB);
    CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);`);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, 0, 0)').run('t1', 'c1');
  const ts = msg(5, msg(1, num(1, 1791700000)));
  const user = Buffer.concat([ts, msg(19, str(2, '帮我看看'))]);
  const agent = text => Buffer.concat([ts, msg(20, str(3, '想一想'), str(1, text))]);
  const ins = db.prepare('INSERT INTO steps VALUES (?, ?, ?)');
  ins.run(0, 14, user); ins.run(1, 15, agent('第一段')); ins.run(2, 15, agent('第二段'));
  const gen = (indices, model) => Buffer.concat([bytes(2, Buffer.concat(indices.map(varint))),
    msg(1, str(19, model), msg(20, str(1, 'model_enum'), str(2, 'MODEL_PLACEHOLDER_M318')))]);
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?, 0)').run(gen([1], 'gemini-3.8-flash-n'));
  db.prepare('INSERT INTO gen_metadata VALUES (1, ?, 0)').run(gen([2], 'gemini-3.8-flash-exp-a'));
  db.close();
  return antigravityAdapter.parseFile(file).then(s => {
    const byText = Object.fromEntries(s.messages.map(m => [m.text, m.model ?? null]));
    assert.equal(byText['帮我看看'], null, '用户消息不带模型');
    assert.equal(byText['第一段'], 'gemini-3.8-flash-n');
    assert.equal(byText['第二段'], 'gemini-3.8-flash-exp-a');
    assert.equal(s.messages.filter(m => m.role === 'thinking').map(m => m.model).join(','), 'gemini-3.8-flash-n,gemini-3.8-flash-exp-a');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('解密 trajectory JSON：generatorMetadata.stepIndices → chatModel.responseModel；占位编号不当模型名', () => {
  const s = trajectoryToSession({ cascadeId: 'c2', steps: [
    { type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { userResponse: 'hi' }, metadata: { createdAt: '2026-10-12T00:00:00Z' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'a' }, metadata: { createdAt: '2026-10-12T00:00:01Z', generatorModel: 'MODEL_PLACEHOLDER_M37' } },
    { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', plannerResponse: { response: 'b' }, metadata: { createdAt: '2026-10-12T00:00:02Z' } },
  ], generatorMetadata: [
    { stepIndices: [1], chatModel: { model: 'MODEL_PLACEHOLDER_M37', responseModel: 'gemini-3.1-pro-high' } },
    { stepIndices: [2], chatModel: { model: 'MODEL_PLACEHOLDER_M8' } },
  ] });
  assert.deepEqual(s.messages.map(m => [m.text, m.model ?? null]), [['hi', null], ['a', 'gemini-3.1-pro-high'], ['b', null]]);
});
