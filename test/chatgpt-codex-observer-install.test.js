import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const installer = fileURLToPath(new URL('../scripts/install-chappie-upstream-observer.mjs', import.meta.url));
test('安装器默认只检查；显式安装有备份且重复安装拒绝', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-chappie-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@zetaloop/chappie', version: '0.5.1-patch.1' }));
  const original = 'prefix\r\n\t\t\trequireChatId(context);\r\n\t\t\tcontext.mcpReq.signal.throwIfAborted();\r\nsuffix\r\n';
  const server = path.join(root, 'src/server.ts'); fs.writeFileSync(server, original);
  const run = extra => spawnSync(process.execPath, [installer, '--chappie-dir', root, ...extra], { encoding: 'utf8' });
  assert.equal(run([]).status, 0); assert.equal(fs.readFileSync(server, 'utf8'), original);
  assert.equal(run(['--apply']).status, 0);
  assert.equal(fs.readFileSync(server + '.before-codex-observer', 'utf8'), original);
  const after = fs.readFileSync(server, 'utf8'); assert.match(after, /observeUpstreamMeta\(context.mcpReq._meta\)/);
  assert.ok(after.includes('prefix\r\n')); assert.ok(fs.existsSync(path.join(root, 'src/codex-upstream-observer.d.ts')));
  assert.notEqual(run(['--apply']).status, 0); assert.equal(fs.readFileSync(server, 'utf8'), after);
});
test('安装器接受本地 fork 的 0.5.1-patch.N，拒绝上游与其他版本', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-chappie-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/server.ts'), '\t\t\trequireChatId(context);\n\t\t\tcontext.mcpReq.signal.throwIfAborted();\n');
  const check = version => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@zetaloop/chappie', version }));
    return spawnSync(process.execPath, [installer, '--chappie-dir', root], { encoding: 'utf8' });
  };
  for (const version of ['0.5.1-patch.1', '0.5.1-patch.2']) assert.equal(check(version).status, 0, version);
  for (const version of ['1.1.0', '0.5.1', '0.5.0', '0.5.1-patch.2-rc']) {
    const result = check(version); assert.notEqual(result.status, 0, version); assert.match(result.stderr, /unsupported_chappie_version/);
  }
});
