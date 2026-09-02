#!/usr/bin/env node
// ChatVault · 薪传 — alias for bin/agent-exporter.js
// 若未带 --experimental-sqlite，先带 flag 重启自身（node:sqlite 在 Node 22.x 需要）
import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (!process.execArgv.includes('--experimental-sqlite')) {
  const r = spawnSync(process.execPath, ['--experimental-sqlite', ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const { fileURLToPath, pathToFileURL } = await import('node:url');
const path = await import('node:path');
const dir = path.dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(path.join(dir, 'agent-exporter.js')).href);
