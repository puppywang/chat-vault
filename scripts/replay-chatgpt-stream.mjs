import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createStreamReplay } from '../src/chatgpt-stream-replay.js';

const input = process.argv[2];
if (!input) { console.error('Usage: node scripts/replay-chatgpt-stream.mjs <capture-directory|legacy-network.json> [report-path]'); process.exit(2); }
const target = path.resolve(input), directory = fs.statSync(target).isDirectory();
let manifest = null;
if (directory) manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
const replay = createStreamReplay({ conversationId: manifest?.conversation_id });
if (directory) {
  const files = fs.readdirSync(target).filter(f => /^batch-\d+-\d+\.jsonl$/.test(f)).sort();
  for (const file of files) {
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(target, file)), crlfDelay: Infinity });
    for await (const line of lines) if (line) replay.accept(JSON.parse(line));
  }
} else {
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (data.dropped_events) replay.accept({ method: 'Capture.gap', params: { reason: 'legacy_recorder_dropped_events', count: data.dropped_events }, at_ms: 0 });
  for (const event of data.events) replay.accept(event);
}
const report = replay.report();
report.capture = manifest;
const output = path.resolve(process.argv[3] || (directory ? path.join(target, 'replay-report.json') : target.replace(/\.json$/, '.replay.json')));
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report_path: output, events: report.events, gaps: report.gaps,
  rounds: report.rounds.map(r => ({ request_id: r.request_id, timing_status: r.timing_status,
    turn_status: r.turn_status,
    ttft_ms: r.ttft_ms, tps: r.tps, tokens: r.token_count, assistant_messages: r.messages.length,
    comparison: r.comparison.status, expected_tokens: r.comparison.expected_tokens,
    differences: r.comparison.differences?.length })) }, null, 2));
