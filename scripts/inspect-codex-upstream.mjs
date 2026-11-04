import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { correlateUpstream } from '../src/codex-upstream-correlation.js';
const args = process.argv.slice(2);
const get = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const input = get('--conversation-file');
if (!input) throw new Error('--conversation-file is required; this tool never fetches or changes conversations');
const journal = get('--journal') || path.join(os.homedir(), '.chat-vault', 'diagnostics', 'codex-upstream-metadata.jsonl');
let conversation = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
if (Array.isArray(conversation)) conversation = conversation[0];
let malformedLines = 0;
const rows = [];
for (const file of [journal, journal + '.1']) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { rows.push(JSON.parse(line)); } catch { ++malformedLines; }
  }
}
const result = { ...correlateUpstream(conversation, rows), journalPresent: fs.existsSync(journal), malformedLines };
const output = get('--output');
if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
