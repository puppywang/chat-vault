// Shared by the MAIN-world hook and Node offline replay; no DOM or Chrome APIs.
(() => {
  function textParts(message) {
    const content = message?.content;
    if (!content || content.content_type === 'model_editable_context') return [];
    const parts = [];
    if (Array.isArray(content.parts)) content.parts.forEach((part, i) => {
      if (typeof part === 'string') parts.push([`/message/content/parts/${i}`, part]);
      else for (const key of ['text', 'content', 'arguments', 'code']) {
        if (typeof part?.[key] === 'string') parts.push([`/message/content/parts/${i}/${key}`, part[key]]);
      }
    });
    for (const key of ['text', 'content', 'arguments', 'code']) {
      if (typeof content[key] === 'string') parts.push([`/message/content/${key}`, content[key]]);
    }
    if (Array.isArray(content.thoughts)) content.thoughts.forEach((thought, i) => {
      for (const key of ['summary', 'content']) {
        if (typeof thought?.[key] === 'string') parts.push([`/message/content/thoughts/${i}/${key}`, thought[key]]);
      }
    });
    if (typeof message.metadata?.reasoning_title === 'string') {
      parts.push(['/message/metadata/reasoning_title', message.metadata.reasoning_title]);
    }
    return parts;
  }
  function createParser({ conversationId = null, userMessageId = null, requestStartMs = null,
    onProgress = () => {}, onText = () => {} } = {}) {
    const state = { conversationId, userMessageId, requestStartMs, firstTextAtMs: null,
      lastTextAtMs: null, completedAtMs: null, outputTokens: null, textChars: 0,
      textChunks: 0, sseFrames: 0, wsFrames: 0, lastFrameAtMs: null,
      serverTtfvtMs: null, error: null, eventShapes: [] };
    const messages = [], byId = new Map(), itemIds = new Set(), shapes = new Map();
    let current = null, path = null, wsPending = '';
    let progressAt = 0, tokenAt = 0, revision = 0;
    const emit = () => onProgress(state);
    const emitTokens = () => {
      if (!current) return;
      const text = [...current.parts.values()].join('');
      if (text) onText({ conversationId: state.conversationId, requestStartMs: state.requestStartMs,
        revision: ++revision, messageIndex: current.index, messageId: current.id,
        firstTextAtMs: state.firstTextAtMs, lastTextAtMs: state.lastTextAtMs,
        textChunks: state.textChunks, text });
    };
    function noteShape(event) {
      const value = event.v;
      const shape = { keys: Object.keys(event).sort().join(','), type: event.type || null,
        op: event.o || null, path: typeof event.p === 'string'
          ? event.p.split('/').slice(0, 5).map(p => /^\d+$/.test(p) ? '#' : p).join('/') : null,
        valueType: Array.isArray(value) ? 'array' : typeof value,
        valueKeys: value && typeof value === 'object' && !Array.isArray(value)
          ? Object.keys(value).sort().join(',') : null,
        messageRole: (event.message || value?.message)?.author?.role || null,
        contentType: (event.message || value?.message)?.content?.content_type || null };
      const key = JSON.stringify(shape), previous = shapes.get(key);
      if (previous) previous.count++;
      else if (shapes.size < 16) { shape.count = 1; shapes.set(key, shape); state.eventShapes.push(shape); }
    }
    function addText(key, value, atMs, replace = false) {
      if (!current || typeof value !== 'string') return;
      const before = current.parts.get(key) || '', after = replace ? value : before + value;
      if (after === before) return;
      current.parts.set(key, after); state.textChars += after.length - before.length; state.textChunks++;
      const first = state.firstTextAtMs == null;
      if (first) state.firstTextAtMs = atMs;
      state.lastTextAtMs = atMs; current.lastTextAtMs = atMs;
      if (first || atMs - progressAt >= 500) { progressAt = atMs; emit(); }
      if (first || atMs - tokenAt >= 1000) { tokenAt = atMs; emitTokens(); }
    }
    function event(value, atMs) {
      if (Array.isArray(value)) { for (const item of value) event(item, atMs); return; }
      if (!value || typeof value !== 'object') return;
      noteShape(value);
      if (typeof value.conversation_id === 'string') state.conversationId = value.conversation_id;
      if (value.type === 'input_message' && typeof value.input_message?.id === 'string') {
        state.userMessageId = value.input_message.id; emit();
      }
      const message = value.message || value.v?.message;
      if (message && typeof message === 'object') {
        emitTokens();
        const id = typeof message.id === 'string' ? message.id : null;
        current = message.author?.role === 'assistant' && message.content?.content_type !== 'model_editable_context'
          ? byId.get(id) || { id, index: messages.length, parts: new Map(),
            channel: message.channel || null, recipient: message.recipient || null } : null;
        path = null;
        if (current) {
          if (current.index === messages.length) messages.push(current);
          if (id) byId.set(id, current);
          for (const [key, text] of textParts(message)) addText(key, text, atMs, true);
        }
      }
      if (typeof value.p === 'string') path = current && (/^\/message\/content\//.test(value.p)
        || value.p === '/message/metadata/reasoning_title') ? value.p : null;
      if (path && typeof value.v === 'string') addText(path, value.v, atMs, value.o === 'replace');
      for (const usage of [value.usage, value.response?.usage, value.metadata?.usage]) {
        const n = usage?.output_tokens ?? usage?.completion_tokens;
        if (Number.isInteger(n) && n >= 0) { state.outputTokens = n; emit(); break; }
      }
      if (value.type === 'server_ste_metadata' && Number.isFinite(value.metadata?.server_ttfvt_ms)) {
        state.serverTtfvtMs = value.metadata.server_ttfvt_ms; emit();
      }
      if (value.type === 'message_stream_complete') { state.completedAtMs = atMs; emit(); emitTokens(); }
    }
    function frames(pending, atMs, transport) {
      for (let match; (match = /\r?\n\r?\n/.exec(pending));) {
        const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { state.error = 'invalid_stream_json'; continue; }
        try {
          event(parsed, atMs); state[transport === 'ws' ? 'wsFrames' : 'sseFrames']++;
          state.lastFrameAtMs = atMs;
        } catch (err) { state.error = `event_handler_failed:${err?.name || 'unknown'}`; emit(); }
      }
      return pending;
    }
    function openSse() {
      const decoder = new TextDecoder(); let pending = '';
      return {
        consume(text, atMs) { pending = frames(pending + text, atMs, 'sse'); },
        consumeBytes(bytes, atMs) { this.consume(decoder.decode(bytes, { stream: true }), atMs); },
        end(atMs) {
          this.consume(decoder.decode(), atMs);
          if (pending.trim()) pending = frames(pending + '\n\n', atMs, 'sse');
          emit(); emitTokens();
        },
        cancel() { pending = ''; decoder.decode(); emit(); emitTokens(); },
      };
    }
    const initialSse = openSse();
    return {
      state, openSse,
      consumeSse(text, atMs) { initialSse.consume(text, atMs); },
      consumeSseBytes(bytes, atMs) { initialSse.consumeBytes(bytes, atMs); },
      endSse(atMs) { initialSse.end(atMs); },
      consumeWs(text, atMs, id) {
        if (typeof text !== 'string' || (typeof id === 'string' && itemIds.has(id))) return;
        if (typeof id === 'string') itemIds.add(id);
        state.completedAtMs = null;
        if (state.error === 'stream_read_failed') state.error = null;
        wsPending = frames(wsPending + text, atMs, 'ws'); emit();
      },
      finish(atMs) { state.completedAtMs ??= atMs; emitTokens(); emit(); },
      readFailed() {
        if (state.completedAtMs == null && !state.wsFrames) state.error = 'stream_read_failed'; emit();
      },
      flush: emitTokens,
      messages() { return messages.map(m => ({ id: m.id, index: m.index, channel: m.channel,
        recipient: m.recipient, text: [...m.parts.values()].join(''), lastTextAtMs: m.lastTextAtMs })); },
    };
  }
  globalThis.ChatVaultStreamParser = { createParser, textParts };
})();
