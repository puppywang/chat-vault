#!/usr/bin/env node
// 统一入口：SQLite 启用/重启逻辑在 cli.js 内部处理
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = path.dirname(fileURLToPath(import.meta.url));
import(pathToFileURL(path.join(dir, '..', 'src', 'cli.js')).href).then(
  (m) => m.main(process.argv.slice(2)),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
