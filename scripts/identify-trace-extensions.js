#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const ids = new Set(process.argv.slice(2));
if (!ids.size) {
  console.error('Usage: node scripts/identify-trace-extensions.js <extension-id> [...]');
  process.exit(2);
}

const root = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
  for (const file of ['Preferences', 'Secure Preferences']) {
    const preferences = path.join(root, entry.name, file);
    if (!fs.existsSync(preferences)) continue;
    const settings = JSON.parse(fs.readFileSync(preferences, 'utf8')).extensions?.settings || {};
    for (const id of ids) {
      const extension = settings[id];
      if (!extension) continue;
      console.log(JSON.stringify({
        profile: entry.name,
        store: file,
        id,
        name: extension.manifest?.name,
        version: extension.manifest?.version,
        path: extension.path,
        state: extension.state,
      }));
    }
  }
}
