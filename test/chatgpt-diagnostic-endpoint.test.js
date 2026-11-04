import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { startServer } from '../src/server.js';

test('本机诊断接口写入 JSONL，同时服务首页和 healthz 正常', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatvault-http-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDb(dbPath);
  const server = startServer(db, { port: 0, dbPath, diagnosticsDir: path.join(dir, 'diagnostics') });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界');
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch (err) {
        if (attempt === 19) throw err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });
  if (!server.listening) await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /<script\b[^>]*>/);
  assert.doesNotMatch(html, /SyntaxError|catch\s*\}\s*function/);
  const response = await fetch(`${base}/api/diagnostics/chatgpt-events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'content', event: 'sync.start', run_id: 'test-run' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const event = JSON.parse(fs.readFileSync(result.file, 'utf8').trim());
  assert.equal(event.event, 'sync.start');
  assert.equal(event.run_id, 'test-run');
  for (const route of ['/api/diagnostics/chatgpt-stream/start', '/api/diagnostics/chatgpt-cdp-command/result', '/api/diagnostics/chatgpt-trace/status']) {
    const removed = await fetch(base + route, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    assert.equal(removed.status,404,route);
  }
  const tabs = await fetch(base+'/api/diagnostics/chatgpt-tabs', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({extension_version:'0.14.0',sampled_at:new Date().toISOString(),tabs:[]})});
  assert.equal(tabs.status,200);
  const snapshot = await tabs.json();
  for(const key of ['trace_command','cdp_command','stream_command']) assert.ok(!(key in snapshot));
});
