import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTabDiagnostics, writeTabDiagnostics } from '../src/chatgpt-tab-diagnostics.js';

const ID = '6ab57c4f-5a4c-83ec-ade9-f4a84c69d90f';

test('ChatGPT 标签页快照保留最后一次成功探针，支持筛选与过期判断', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-tab-diag-'));
  const file = path.join(dir, 'snapshot.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });

  assert.equal(readTabDiagnostics({ file }).status, 'no_snapshot');
  const tab = { tab_id: 9, window_id: 2, url: `https://chatgpt.com/c/${ID}`,
    title: '分析参考版本切片逻辑', active: true, tab_status: 'complete', discarded: false };
  writeTabDiagnostics({ extension_version: '0.6.0', sampled_at: new Date().toISOString(), tabs: [
    { ...tab, probe_status: 'responsive', probe_duration_ms: 12, page: { rendered_message_count: 3816 } },
  ] }, file);

  let result = readTabDiagnostics({ file, conversationId: ID, tabId: 9 });
  assert.equal(result.status, 'current');
  assert.equal(result.extension_version, '0.6.0');
  assert.equal(result.matched_tabs, 1);
  assert.equal(result.tabs[0].page.rendered_message_count, 3816);
  const lastResponsive = result.tabs[0].last_responsive_at;

  writeTabDiagnostics({ tabs: [{ ...tab, probe_status: 'timeout', probe_duration_ms: 2000,
    probe_error: '页面探针 2 秒未响应' }] }, file);
  result = readTabDiagnostics({ file, conversationId: ID });
  assert.equal(result.tabs[0].probe_status, 'timeout');
  assert.equal(result.tabs[0].consecutive_probe_failures, 1);
  assert.equal(result.tabs[0].last_responsive_at, lastResponsive);
  assert.equal(result.tabs[0].last_responsive_page.rendered_message_count, 3816);
  assert.equal(readTabDiagnostics({ file, conversationId: '00000000-0000-0000-0000-000000000000' }).matched_tabs, 0);

  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  old.received_at = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(readTabDiagnostics({ file }).status, 'stale');
});

test('拒绝非 ChatGPT 标签页和未知探针状态', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-tab-diag-'));
  const file = path.join(dir, 'snapshot.json');
  t.after(() => fs.rmdirSync(dir));
  assert.throws(() => writeTabDiagnostics({ tabs: [
    { tab_id: 1, url: 'https://example.com/', probe_status: 'responsive' },
  ] }, file), /无效的 ChatGPT 标签页/);
  assert.throws(() => writeTabDiagnostics({ tabs: [
    { tab_id: 1, url: 'https://chatgpt.com/', probe_status: 'unknown' },
  ] }, file), /无效的 probe_status/);
});

test('dots 路由也作为可定位的 ChatGPT 页面保存', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-tab-diag-'));
  const file = path.join(dir, 'snapshot.json');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  const dotsId = '01a0f178-337c-76ad-ab15-57376055ec42';
  writeTabDiagnostics({ tabs: [{ tab_id: 12, window_id: 2,
    url: `https://chatgpt.com/dots/${dotsId}`, title: 'little', active: true,
    tab_status: 'complete', discarded: false, probe_status: 'responsive',
    page: { conversation_id: null, dots_id: dotsId, conversation_key: `dots-${dotsId}` } }] }, file);
  const result = readTabDiagnostics({ file, tabId: 12 });
  assert.equal(result.matched_tabs, 1);
  // Existing server contract: top-level conversation_id is the unified diagnostic routing ID.
  // The page's ordinary ChatGPT ID remains null and its archive key remains dots-prefixed.
  assert.equal(result.tabs[0].conversation_id, dotsId);
  assert.equal(result.tabs[0].dots_id, dotsId);
  assert.equal(result.tabs[0].page.conversation_id, null);
  assert.equal(result.tabs[0].page.conversation_key, `dots-${dotsId}`);
  assert.equal(readTabDiagnostics({ file, conversationId: dotsId }).matched_tabs, 1);
  assert.equal(readTabDiagnostics({ file, conversationId: ID }).matched_tabs, 0);
});

test('快照文件损坏（如非正常关机后全 0）时挪开重建，不阻塞后续写入', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-tab-diag-'));
  const file = path.join(dir, 'snapshot.json');
  t.after(() => { for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f)); fs.rmdirSync(dir); });
  fs.writeFileSync(file, Buffer.alloc(4096));
  assert.equal(readTabDiagnostics({ file }).status, 'no_snapshot');
  writeTabDiagnostics({ tabs: [{ tab_id: 1, window_id: 1, url: `https://chatgpt.com/c/${ID}`, title: 't', probe_status: 'responsive', page: {} }] }, file);
  assert.equal(readTabDiagnostics({ file }).tabs.length, 1);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('snapshot.json.corrupt-')), '坏文件留档');
});
