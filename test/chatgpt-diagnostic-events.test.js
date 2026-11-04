import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendChatgptDiagnosticEvent } from '../src/chatgpt-diagnostic-events.js';

test('诊断事件追加到本机 JSONL，保留关联字段', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatvault-events-'));
  t.after(() => {
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const first = appendChatgptDiagnosticEvent({ event: 'sync.start', run_id: 'r1',
    details: { mapping_nodes: 5524 } }, dir);
  appendChatgptDiagnosticEvent({ event: 'sync.end', run_id: 'r1' }, dir);
  const lines = fs.readFileSync(first.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].run_id, 'r1');
  assert.equal(lines[0].details.mapping_nodes, 5524);
  assert.ok(lines[0].received_at);
  assert.equal(lines[1].event, 'sync.end');
});

test('缺少事件名时拒绝写入', () => {
  assert.throws(() => appendChatgptDiagnosticEvent({}), /event/);
});
