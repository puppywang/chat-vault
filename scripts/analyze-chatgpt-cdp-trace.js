#!/usr/bin/env node

// Summarize a local Chrome trace without printing the raw (potentially sensitive) events.
import fs from 'node:fs';
import path from 'node:path';

const tracePath = process.argv[2];
if (!tracePath) {
  console.error('Usage: node scripts/analyze-chatgpt-cdp-trace.js <trace.json>');
  process.exit(2);
}

const trace = JSON.parse(fs.readFileSync(path.resolve(tracePath), 'utf8'));
const events = Array.isArray(trace) ? trace : trace.traceEvents;
if (!Array.isArray(events)) throw new Error('Trace has no traceEvents array');

const threads = new Map();
const processes = new Map();
for (const event of events) {
  if (event.ph !== 'M') continue;
  if (event.name === 'thread_name') threads.set(`${event.pid}:${event.tid}`, event.args?.name);
  if (event.name === 'process_name') processes.set(event.pid, event.args?.name);
}

const timed = events.filter(event => event.ph === 'X' && Number.isFinite(event.ts) && Number.isFinite(event.dur));
const minTs = timed.reduce((minimum, event) => Math.min(minimum, event.ts), Infinity);
const maxTs = timed.reduce((maximum, event) => Math.max(maximum, event.ts + event.dur), 0);
const sourceOf = event => {
  const data = event.args?.data || {};
  const raw = data.url || data.scriptName || data.fileName || '';
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 220);
  } catch {
    return String(raw).slice(0, 220);
  }
};
const mainKeys = [...threads.entries()]
  .filter(([, name]) => /CrRendererMain|RendererMain|MainThread/i.test(name || ''))
  .map(([key]) => key);
const mainSet = new Set(mainKeys);
const main = timed.filter(event => mainSet.has(`${event.pid}:${event.tid}`));
const tasks = main.filter(event => /^(RunTask|ThreadControllerImpl::RunTask|TaskQueueManager::ProcessTaskFromWorkQueue)$/.test(event.name));
const byName = new Map();
for (const event of main) {
  const item = byName.get(event.name) || { count: 0, totalMs: 0, maxMs: 0 };
  const ms = event.dur / 1000;
  item.count++;
  item.totalMs += ms;
  item.maxMs = Math.max(item.maxMs, ms);
  byName.set(event.name, item);
}

const topTasks = [...tasks].sort((a, b) => b.dur - a.dur).slice(0, 20).map(task => {
  const inside = main.filter(event =>
    event !== task && event.tid === task.tid && event.pid === task.pid &&
    event.ts >= task.ts && event.ts + event.dur <= task.ts + task.dur &&
    event.dur >= 1000
  ).sort((a, b) => b.dur - a.dur).slice(0, 7);
  return {
    atSeconds: Number(((task.ts - minTs) / 1e6).toFixed(2)),
    durationMs: Number((task.dur / 1000).toFixed(1)),
    thread: `${task.pid}:${task.tid}`,
    nested: inside.map(event => ({ name: event.name, ms: Number((event.dur / 1000).toFixed(1)), source: sourceOf(event) })),
  };
});

const buckets = new Map();
for (const event of tasks) {
  const second = Math.floor((event.ts - minTs) / 1e6);
  const item = buckets.get(second) || { second, taskMs: 0, longTaskCount: 0, maxTaskMs: 0 };
  const ms = event.dur / 1000;
  item.taskMs += ms;
  if (ms >= 50) item.longTaskCount++;
  item.maxTaskMs = Math.max(item.maxTaskMs, ms);
  buckets.set(second, item);
}

const networkNames = /ResourceSendRequest|ResourceReceiveResponse|ResourceFinish|ResourceReceivedData|WebSocket|XHRReadyStateChange|Fetch/i;
const networkCounts = new Map();
const requests = new Map();
for (const event of events) {
  if (!networkNames.test(event.name || '')) continue;
  networkCounts.set(event.name, (networkCounts.get(event.name) || 0) + 1);
  const data = event.args?.data || {};
  if (data.requestId === undefined) continue;
  const key = `${event.pid}:${data.requestId}`;
  const item = requests.get(key) || { requestId: key };
  if (event.name === 'ResourceSendRequest') {
    item.start = event.ts;
    item.source = sourceOf(event);
    item.resourceType = data.resourceType;
  }
  if (event.name === 'ResourceReceiveResponse') {
    item.response = event.ts;
    item.mimeType = data.mimeType;
    item.statusCode = data.statusCode;
  }
  if (event.name === 'ResourceReceivedData') item.encodedBytes = (item.encodedBytes || 0) + (data.encodedDataLength || 0);
  if (event.name === 'ResourceFinish') {
    item.finish = event.ts;
    item.decodedBytes = data.decodedBodyLength;
  }
  requests.set(key, item);
}

const profileNodes = new Map();
const profileChunks = events.filter(event => event.name === 'ProfileChunk' && event.args?.data?.cpuProfile);
for (const event of profileChunks) {
  const key = `${event.pid}:${event.tid}`;
  const nodes = profileNodes.get(key) || new Map();
  for (const node of event.args.data.cpuProfile.nodes || []) nodes.set(node.id, node);
  profileNodes.set(key, nodes);
}
const profileSources = new Map();
for (const event of profileChunks) {
  const profile = event.args.data.cpuProfile;
  const nodes = profileNodes.get(`${event.pid}:${event.tid}`);
  for (let index = 0; index < (profile.samples || []).length; index++) {
    const node = nodes.get(profile.samples[index]);
    const frame = node?.callFrame;
    if (!frame) continue;
    const url = frame.url || `[${frame.functionName || 'unknown'}]`;
    const source = sourceOf({ args: { data: { url } } });
    profileSources.set(source, (profileSources.get(source) || 0) + ((event.args.data.timeDeltas || [])[index] || 0));
  }
}
const profileOrigins = new Map();
for (const [source, micros] of profileSources) {
  const origin = source.startsWith('https://chatgpt.com/') ? 'chatgpt.com'
    : source.startsWith('chrome-extension://') ? source.split('/').slice(0, 3).join('/')
      : source.startsWith('[') ? '[V8/native]' : source;
  profileOrigins.set(origin, (profileOrigins.get(origin) || 0) + micros);
}

const round = value => Number(value.toFixed(1));
const result = {
  traceFile: path.basename(tracePath),
  eventCount: events.length,
  timedEventCount: timed.length,
  traceSpanSeconds: round((maxTs - minTs) / 1e6),
  rendererMainThreads: mainKeys.map(key => {
    const pid = Number(key.split(':')[0]);
    return { key, threadName: threads.get(key), processName: processes.get(pid) };
  }),
  taskCount: tasks.length,
  longTaskCount: tasks.filter(event => event.dur >= 50000).length,
  taskTotalMs: round(tasks.reduce((total, event) => total + event.dur / 1000, 0)),
  byName: [...byName.entries()]
    .map(([name, item]) => ({ name, count: item.count, totalMs: round(item.totalMs), maxMs: round(item.maxMs) }))
    .sort((a, b) => b.totalMs - a.totalMs).slice(0, 35),
  topTasks,
  busySeconds: [...buckets.values()].sort((a, b) => b.taskMs - a.taskMs).slice(0, 20)
    .map(item => ({ second: item.second, taskMs: round(item.taskMs), longTaskCount: item.longTaskCount, maxTaskMs: round(item.maxTaskMs) })),
  networkEventCounts: [...networkCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
  cpuProfileTopSources: [...profileSources.entries()]
    .map(([source, micros]) => ({ source, sampledMs: round(micros / 1000) }))
    .sort((a, b) => b.sampledMs - a.sampledMs).slice(0, 20),
  cpuProfileOrigins: [...profileOrigins.entries()]
    .map(([origin, micros]) => ({ origin, sampledMs: round(micros / 1000) }))
    .sort((a, b) => b.sampledMs - a.sampledMs),
  slowRequests: [...requests.values()].filter(item => item.start && item.finish)
    .map(item => ({
      source: item.source,
      resourceType: item.resourceType,
      mimeType: item.mimeType,
      statusCode: item.statusCode,
      encodedBytes: item.encodedBytes,
      decodedBytes: item.decodedBytes,
      atSeconds: round((item.start - minTs) / 1e6),
      responseMs: item.response ? round((item.response - item.start) / 1000) : undefined,
      totalMs: round((item.finish - item.start) / 1000),
    })).sort((a, b) => b.totalMs - a.totalMs).slice(0, 20),
};
console.log(JSON.stringify(result, null, 2));
