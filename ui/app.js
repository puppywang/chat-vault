// agent-exporter Web UI：hash 路由（URL 留痕/还原）+ 时间线 / 工作区 / 搜索 / 会话详情
//
// 路由格式：
//   #/timeline?agent=codex&ws=12&q=关键词
//   #/workspaces
//   #/session/538?msg=1234   （msg 可选，定位并高亮某条消息）
// 视图/会话切换写入历史（可前进后退）；搜索输入中只 replaceState 不产生历史。

// 本地偏好（隐私模式等 localStorage 不可用时静默降级为不记住）
const prefGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const prefSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* */ } };

const state = {
  view: 'timeline',      // timeline | workspaces | flagged | settings | session
  simple: prefGet('cv:simple') === '1', // 会话简要模式：折叠工具细节，突出用户与助手正文（记住上次选择）
  sort: prefGet('cv:search-sort') || 'hit', // 搜索结果排序：hit=首次命中 | start=会话开始 | end=会话结束（记住上次选择）
  agent: null,
  workspaceIds: [],     // 工作区过滤（Shift+点击多选，URL: ws=1,17,42）
  query: '',
  sessionId: null,
  focusMsgId: null,
  frag: null,            // {prefix?, start, suffix?} 文本片段高亮（:~:text= 格式）
  preview: null,         // {path, line} 文件预览（进 URL，可复制还原）
  agentsMeta: {},
};

const $content = document.getElementById('content');
const $search = document.getElementById('search-input');
const $agentFilters = document.getElementById('agent-filters');
const $wsList = document.getElementById('workspace-list');
const $statsBox = document.getElementById('stats-box');

const api = {
  async get(path) {
    const r = await fetch(path);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `${r.status}`);
    }
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  },
  async put(path, body) {
    const r = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `${r.status}`);
    return data;
  },
};

function toast(msg) {
  let t = document.getElementById('ae-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ae-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 把字符串编码为可安全嵌入 inline onclick JS 字符串字面量（单引号包裹）的形式。
// encodeURIComponent 不编码单引号（RFC 3986 sub-delims），会破坏 '...' 字面量，
// 因此额外把 ' 替换为 %27；双引号/反引号/反斜杠等也一并编码，杜绝属性截断与 JS 语法错误。
function encJsStr(s) {
  return encodeURIComponent(String(s ?? '')).replace(/'/g, '%27');
}

/** 会话详情的 hash 链接（与 serializeState 的 session 分支格式一致）。
 *  用于 <a href>：浏览器原生右键"新标签页打开"/中键/Ctrl+点击 直接可用。
 *  encFragText 是已经过 encJsStr 编码的关键词（与渲染处共用一份编码结果） */
function sessionHref(id, focusMsgId = null, encFragText = null) {
  const parts = [];
  if (state.query) parts.push(`q=${encodeURIComponent(state.query)}`);
  if (focusMsgId != null) {
    const fragPart = encFragText ? `:~:text=${encFragText}` : '';
    parts.push(`msg=${encodeURIComponent(`${focusMsgId}${fragPart}`)}`);
  }
  if (state.simple) parts.push('simple=1');
  return `#/session/${id}${parts.length ? '?' + parts.join('&') : ''}`;
}

// ---------- 本地文件链接 → 工具内预览 ----------
// agent 输出里常见的本地文件链接目标解析为 {path, line}，点击后在侧滑面板中预览。
// 支持形式（可带 :line 或 :line:col）：
//   /D:/path/file.c:205   D:/path/file.c:205   D:\path\file.c:205   file:///d%3A/path/file.c:205
function parseFileLink(u) {
  let s;
  try { s = decodeURIComponent(u); } catch { s = u; }
  s = s.replace(/\\/g, '/');
  let m;
  if ((m = s.match(/^file:\/\/\/+([a-zA-Z]:\/.+)$/))) s = m[1];
  else if ((m = s.match(/^\/+([a-zA-Z]):\/(.+)$/))) s = m[1] + ':/' + m[2];
  else if (!/^[a-zA-Z]:\/.+/.test(s)) return null;
  // 剥离尾部 :line / :line:col（要求主路径段含 /，避免误拆盘符冒号）
  const lm = s.match(/^(.+\/[^/]+):(\d+)(?::\d+)?$/);
  let line = null;
  if (lm) { s = lm[1]; line = Number(lm[2]); }
  return { path: s, line };
}

// ---------- 轻量 Markdown 渲染（先转义，再生成受控标签） ----------

function renderMarkdown(src) {
  if (!src) return '';
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false, codeBuf = [], codeLang = '';
  let listType = null; // 'ul' | 'ol'

  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  const inline = (text) => {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      const fl = parseFileLink(u);
      if (fl) {
        return `<a class="file-link" data-path="${esc(fl.path)}" data-line="${fl.line ?? ''}"
                   title="${esc(u)}">📎 ${t}</a>`;
      }
      if (/^(https?:|#|\/)/i.test(u)) return `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
      return t;
    });
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*(\w*)/);
    if (fence) {
      if (inCode) {
        if (codeBuf.join('').trim()) { // 空代码块不渲染（agent 输出里常见的占位围栏）
          out.push(`<pre class="code-block"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        }
        inCode = false; codeBuf = [];
      } else {
        closeList();
        inCode = true; codeLang = fence[1];
      }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (!line.trim()) { closeList(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      closeList();
      const lv = Math.min(heading[1].length + 2, 6); // h3 起，避免过大
      out.push(`<h${lv}>${inline(heading[2])}</h${lv}>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeList();
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        out.push('<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      i--;
      out.push('</tbody></table>');
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeBuf.join('').trim()) {
    out.push(`<pre class="code-block"><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  }
  closeList();
  return out.join('\n');
}

// ---------- 用户消息中的 agent 内部标签 → 友好 UI ----------
// Claude Code 等会在用户消息里夹带 <command-name>/<local-command-stdout>/<ide_opened_file> 等标签，
// 提取为命令块 / 提示行 / 折叠块，正文只留用户真实输入。

/** Codex 粘贴消息专门布局：
 *  # Files pasted by the user:  → 文件路径列表折叠为 details
 *  ## My request:              → 用户真实请求 → 高亮卡片
 *  --- pasted attachment ---   → 展开的附件正文 → 等宽块
 * 识别不到该结构时返回 null，走默认 markdown 渲染 */
function renderCodexPaste(text) {
  // 命中 Codex 粘贴结构（有文件列表或 My request 标记）才走专门布局
  if (!/^# Files pasted by the user:/m.test(text) && !/^## My request:\s*$/m.test(text)) return null;
  const lines = String(text).split('\n');
  const head = [], files = [], request = [], attachment = [];
  let sec = 'head';
  for (const line of lines) {
    if (/^# Files pasted by the user:\s*$/.test(line)) { sec = 'files'; continue; }
    if (/^## My request:\s*$/.test(line)) { sec = 'request'; continue; }
    if (/^---\s*pasted attachment/.test(line)) { sec = 'attachment'; continue; }
    (sec === 'head' ? head : sec === 'files' ? files : sec === 'request' ? request : attachment).push(line);
  }
  const html = [];
  if (head.length) html.push(renderMarkdown(head.join('\n')));
  if (files.length) {
    // 从 `## "[时间] 标题…": 路径` 提取可读标题；提取失败则保留原始行
    const items = files.map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^#{1,6}\s*"\[([^\]]*)\]\s*([^"]*)":\s*(.+)$/);
      if (m) return { label: `${m[1] ? `[${m[1]}] ` : ''}${m[2].trim()}`, raw: l };
      return { label: l.replace(/^#{1,6}\s*/, ''), raw: l };
    });
    const label = items.length > 1 ? `📎 粘贴文件 (${items.length})` : `📎 粘贴文件：${items[0].label}`;
    html.push(`<details class="pasted-files"><summary title="点击展开完整路径">${esc(label)}</summary><pre>${esc(items.map((i) => i.raw).join('\n'))}</pre></details>`);
  }
  if (request.length) {
    html.push(`<div class="user-request"><div class="req-label">💬 我的请求</div><div class="req-body">${renderMarkdown(request.join('\n'))}</div></div>`);
  }
  if (attachment.length) {
    html.push(`<div class="pasted-att"><div class="att-label">📄 附件内容</div><pre>${esc(attachment.join('\n'))}</pre></div>`);
  }
  return html.join('');
}

function renderUserMessage(text) {
  let s = String(text ?? '');
  const extras = [];
  const take = (re, fn) => {
    s = s.replace(re, (...args) => { extras.push(fn(...args)); return ''; });
  };

  // 斜杠命令：name + (args|contents) + stdout 组合成命令块
  const cmdName = s.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  const cmdArgs =
    s.match(/<command-contents>([\s\S]*?)<\/command-contents>/)?.[1]?.trim() ??
    s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '';
  const stdout = s.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim();
  if (cmdName) {
    take(/<command-name>[\s\S]*?<\/command-name>/g, () => '');
    take(/<command-message>[\s\S]*?<\/command-message>/g, () => '');
    take(/<command-(?:args|contents)>[\s\S]*?<\/command-(?:args|contents)>/g, () => '');
    take(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, () => '');
    extras.push(`
      <div class="cmd-block">
        <div class="cmd-line">❯ ${esc(cmdName)}${cmdArgs ? ' ' + esc(cmdArgs) : ''}</div>
        ${stdout ? `<details class="cmd-out"><summary>输出</summary><pre>${esc(stdout.slice(0, 1000))}</pre></details>` : ''}
      </div>`);
  } else if (stdout !== undefined) {
    take(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, () => '');
    extras.push(`<div class="cmd-block"><div class="cmd-line">❯ 本地命令</div><details class="cmd-out"><summary>输出</summary><pre>${esc(stdout.slice(0, 1000))}</pre></details></div>`);
  }

  take(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, () =>
    `<div class="sys-note">⚠ 本地命令记录（agent 被要求忽略）</div>`);
  take(/<ide_opened_file>([\s\S]*?)<\/ide_opened_file>/g, (_, t) =>
    `<div class="sys-note">📂 ${esc(t.trim().split('\n')[0])}</div>`);
  take(/<ide_selection>[\s\S]*?<\/ide_selection>/g, (m) =>
    `<details class="sys-note"><summary>✂ IDE 选区</summary><pre>${esc(m.replace(/<\/?ide_selection>/g, '').trim().slice(0, 800))}</pre></details>`);
  take(/<system-reminder>[\s\S]*?<\/system-reminder>/g, (m) =>
    `<details class="sys-note"><summary>⚙ 系统提示</summary><pre>${esc(m.replace(/<\/?system-reminder>/g, '').trim().slice(0, 800))}</pre></details>`);

  // 其余未知 <tag>…</tag>：仅当标签位于行首且不是常见 HTML 标签时才折叠
  // （行首 = agent 内部注入的格式特征；排除 HTML 标签 = 用户粘贴的网页/代码片段保持原样）
  const HTML_TAGS = /^(?:p|div|span|li|ul|ol|h[1-6]|td|tr|th|table|thead|tbody|br|hr|a|img|pre|code|em|strong|b|i|u|blockquote|section|article|header|footer|button|input|select|option|style|script)$/i;
  take(/(?:^|\n)[ \t]*<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g, (m, tag, body) => {
    if (HTML_TAGS.test(tag)) return m; // 保留原文，走 markdown/escape
    return body.trim()
      ? `\n<details class="sys-note"><summary>&lt;${esc(tag)}&gt;</summary><pre>${esc(body.trim().slice(0, 800))}</pre></details>`
      : '\n';
  });

  // Codex 粘贴结构（Files pasted + My request + attachment）走专门布局，否则默认 markdown
  const codexPaste = renderCodexPaste(s);
  return (codexPaste ?? renderMarkdown(s)) + extras.join('');
}

// ---------- 路由 ----------

/** text fragment 字符串（[prefix-,]start[,-suffix]）→ 对象 */
function parseFragStr(s) {
  const parts = String(s).split(',');
  if (parts.length === 1) return { start: parts[0] };
  if (parts.length === 2) {
    if (parts[0].endsWith('-') && parts[0].length > 1) return { prefix: parts[0].slice(0, -1), start: parts[1] };
    if (parts[1].startsWith('-')) return { start: parts[0], suffix: parts[1].slice(1) };
    return { start: parts[0], end: parts[1] };
  }
  // 3 段: prefix-,start,-suffix
  return {
    prefix: parts[0].replace(/-$/, ''),
    start: parts[1],
    suffix: parts[2].replace(/^-/, ''),
  };
}

function fragToStr(f) {
  return [f.prefix ? f.prefix + '-,' : '', f.start, f.suffix ? ',-' + f.suffix : ''].join('');
}

function serializeState() {
  if (state.view === 'session') {
    // session 视图手动编码拼接：msg 值整体 encodeURIComponent，
    // 使 ":~:text=" 变为 %3A~%3Atext%3D —— 避免被 Chrome 加载时当作 text fragment 剥离
    const parts = [];
    if (state.preview) {
      parts.push(`file=${encodeURIComponent(state.preview.path)}`);
      if (state.preview.line) parts.push(`fline=${state.preview.line}`);
    }
    if (state.query) parts.push(`q=${encodeURIComponent(state.query)}`);
    if (state.focusMsgId) {
      const fragPart = state.frag ? `:~:text=${encodeURIComponent(fragToStr(state.frag))}` : '';
      parts.push(`msg=${encodeURIComponent(`${state.focusMsgId}${fragPart}`)}`);
    }
    if (state.simple) parts.push('simple=1');
    return `#/session/${state.sessionId}${parts.length ? '?' + parts.join('&') : ''}`;
  }
  const params = new URLSearchParams();
  if (state.preview) {
    params.set('file', state.preview.path);
    if (state.preview.line) params.set('fline', state.preview.line);
  }
  if (state.agent) params.set('agent', state.agent);
  if (state.workspaceIds.length) params.set('ws', state.workspaceIds.join(','));
  if (state.query) params.set('q', state.query);
  if (state.sort && state.sort !== 'hit') params.set('sort', state.sort);
  const qs = params.toString();
  return `#/${state.view}${qs ? '?' + qs : ''}`;
}

function parseHash() {
  const h = location.hash || '#/timeline';
  const [pathPart, queryPart] = h.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(queryPart || '');
  const preview = params.get('file')
    ? { path: params.get('file'), line: params.get('fline') ? Number(params.get('fline')) : null }
    : null;
  // msg 参数可带 :~:text= 片段
  let focusMsgId = null;
  let frag = null;
  const msgParam = params.get('msg');
  if (msgParam) {
    const ti = msgParam.indexOf(':~:text=');
    if (ti >= 0) {
      focusMsgId = Number(msgParam.slice(0, ti)) || null;
      try { frag = parseFragStr(decodeURIComponent(msgParam.slice(ti + 8))); } catch { frag = null; }
    } else {
      focusMsgId = Number(msgParam) || null;
    }
  }
  const seg = (pathPart || 'timeline').split('/').filter(Boolean);
  if (seg[0] === 'session' && seg[1]) {
    const sess = {
      view: 'session', sessionId: Number(seg[1]),
      focusMsgId, frag,
      query: params.get('q') || '',
      preview,
    };
    // URL 带 simple 参数才覆盖；否则沿用记住的偏好（不写键，避免 Object.assign 重置）
    if (params.has('simple')) sess.simple = params.get('simple') === '1';
    return sess;
  }
  return {
    view: ['workspaces', 'flagged', 'settings'].includes(seg[0]) ? seg[0] : 'timeline',
    flagTab: params.get('flag') === 'star' ? 'star' : 'todo',
    agent: params.get('agent') || null,
    workspaceIds: (params.get('ws') || '').split(',').map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0),
    query: params.get('q') || '',
    preview,
    // sort 带 URL 参数才覆盖；否则沿用记住的偏好（不写键，避免 Object.assign 重置）
    ...(['hit', 'start', 'end'].includes(params.get('sort')) ? { sort: params.get('sort') } : {}),
  };
}

/** 状态变化的滚动行为：离开列表进会话 → 记录列表位置；从会话回列表 → 标记恢复 */
let listScrollPos = null;
let shouldRestoreScroll = false;
function onRouteChange(prev) {
  const main = document.querySelector('main');
  if (prev.view !== 'session' && state.view === 'session') {
    listScrollPos = main ? main.scrollTop : 0;      // 记住列表位置
    shouldRestoreScroll = false;
  } else if (prev.view === 'session' && state.view !== 'session') {
    shouldRestoreScroll = true;                     // 返回列表时恢复
  } else if (prev.view !== 'session') {
    shouldRestoreScroll = false;                    // 列表内切换（改词/换视图）回顶部
  }
}

/** 列表渲染完成后执行：恢复上次位置（仅从会话返回时） */
function restoreListScroll() {
  if (!shouldRestoreScroll) return;
  shouldRestoreScroll = false;
  const main = document.querySelector('main');
  if (main && listScrollPos != null) main.scrollTop = listScrollPos;
}

/** 只有 preview 变化（打开/关闭/切换文件预览）时不重渲染主内容——
 *  会话滚动位置保持不动，只更新侧滑面板 */
function isPreviewOnlyChange(prev) {
  const keys = ['view', 'sessionId', 'focusMsgId', 'frag', 'query', 'agent', 'workspaceIds', 'flagTab', 'simple', 'sort'];
  return keys.every((k) => Object.is(prev[k], state[k])) && !Object.is(prev.preview, state.preview);
}

/** 状态变化入口：写 URL（默认产生历史条目），hashchange 触发重渲染 */
function navigate(next, { replace = false } = {}) {
  const prev = { ...state };
  Object.assign(state, next);
  onRouteChange(prev);
  // 立刻同步导航高亮/侧栏形态：不等 fetch，点击后 UI 立即有反馈
  syncControls();
  const hash = serializeState();
  if (location.hash === hash) { rerender(prev); return; }
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  rerender(prev);
}

function rerender(prev) {
  if (isPreviewOnlyChange(prev)) { syncControls(); updatePreview(); return; }
  render();
}

window.addEventListener('popstate', () => {
  const prev = { ...state };
  Object.assign(state, parseHash());
  onRouteChange(prev);
  syncControls();
  rerender(prev);
});

// 地址栏直接修改 hash（或外部链接跳转）时同步状态
window.addEventListener('hashchange', () => {
  if (location.hash === serializeState()) return; // 自己发起的导航已渲染
  const prev = { ...state };
  Object.assign(state, parseHash());
  onRouteChange(prev);
  syncControls();
  rerender(prev);
});

// 让顶部搜索框 / agent chips / 侧栏与 state 同步（不触发导航）

// 设置页的退出目标：进入设置前的列表视图（session 不是列表，跳过不覆盖）
let lastListView = 'timeline';

// 供设置页 inline onclick 调用
window.exitSettings = () =>
  navigate({ view: lastListView, query: '', workspaceIds: [], sessionId: null });

function syncControls() {
  if (document.activeElement !== $search) $search.value = state.query;
  $agentFilters.querySelectorAll('.agent-chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.agent === state.agent));
  renderWsList();
  document.querySelectorAll('.nav-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  // 设置是整页接管：隐藏侧栏和顶部搜索/agent 过滤，只留品牌 + 齿轮开关
  document.getElementById('settings-btn')?.classList.toggle('active', state.view === 'settings');
  document.body.classList.toggle('mode-settings', state.view === 'settings');
  if (state.view !== 'settings' && state.view !== 'session') lastListView = state.view;
}

// ---------- 渲染 ----------

function fmtDay(iso) {
  if (!iso) return '未知时间';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = (today - day) / 86400000;
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtFull(iso) {
  if (!iso) return '';
  const d = new Date(iso); // 库内 UTC → 本地（与消息时间/作息图一致）
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 消息时间（HH:MM），悬停显示完整年月日时分 */
function fmtTimeT(iso) {
  if (!iso) return '';
  return `<span title="${fmtFull(iso)}">${fmtTime(iso)}</span>`;
}
/** 会话起止时间线路（本地时区）：同日共享日期前缀（YYYY-MM-DD HH:MM → HH:MM），跨日两端全显；悬停给完整区间 */
function fmtRange(a, b) {
  const from = fmtFull(a || b), to = fmtFull(b || a);
  if (!from) return '';
  if (!to || from === to) return `<span title="${from}">${from}</span>`;
  const text = from.slice(0, 10) === to.slice(0, 10)
    ? `${from.slice(0, 16)} → ${to.slice(11, 16)}`
    : `${from} → ${to}`;
  return `<span title="${from} → ${to}">${text}</span>`;
}

function agentBadge(agent) {
  const meta = state.agentsMeta[agent] || { label: agent, color: '#888' };
  return `<span class="agent-badge" style="background:${meta.color}">${esc(meta.label)}</span>`;
}

function renderSessionCard(s, hitsHtml = '', focusMsgId = null, fragText = null) {
  // 外层用真 <a href>：右键"新标签页打开"/中键/Ctrl+点击 由浏览器原生处理；
  // 左键 preventDefault 后仍走 SPA 路由（保留列表滚动位置恢复等行为）
  const encFrag = fragText ? encJsStr(fragText) : null;
  const inChain = state.chainIds?.has(s.id) ? '<span class="chain-badge" title="该会话在"继续对话"链中：有 agent 交接/引用关系">🔗</span>' : '';
  return `
  <a class="session-card" href="${sessionHref(s.id, focusMsgId, encFrag)}"
     onclick="if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openSession(${s.id}${focusMsgId ? `, ${focusMsgId}, '${encFrag}'` : ''})">
    <button class="card-hide" title="隐藏此会话（设置页可恢复）" onclick="event.stopPropagation();hideSession(${s.id}, true, this)">🙈</button>
    <div class="session-title">${inChain}${esc(s.title || '(无标题)')}</div>
    <div class="session-meta">
      ${agentBadge(s.agent)}
      <span title="${esc(s.workspace_path || '')}">${esc(s.workspace_name || '未知工作区')}</span>
      <span>${fmtRange(s.created_at, s.updated_at)}</span>
      <span>${s.message_count} 条消息</span>
    </div>
    ${hitsHtml}
  </a>`;
}

function renderFlagged(messages, tab) {
  const tabs = `
  <div class="flag-tabs">
    <button class="flag-tab ${tab === 'todo' ? 'active' : ''}" onclick="switchFlagTab('todo')">🚩 TODO (${tab === 'todo' ? messages.length : ''})</button>
    <button class="flag-tab ${tab === 'star' ? 'active' : ''}" onclick="switchFlagTab('star')">⭐ 收藏</button>
  </div>`;
  if (!messages.length) {
    return `${tabs}<div class="empty">还没有${tab === 'todo' ? ' TODO 标记' : '收藏'}的消息。<br>在会话里把鼠标悬停到消息右上角，点 🚩 或 ⭐ 标记。</div>`;
  }
  const items = messages.map((m) => `
    <a class="flag-item" href="${sessionHref(m.session_id, m.seq)}"
       onclick="if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); openSession(${m.session_id},${m.seq})">
      <div class="flag-head">
        ${agentBadge(m.agent)}
        <span class="flag-title">${esc(m.title || '(无标题)')}</span>
        <span class="flag-time">${fmtFull(m.updated_at)}</span>
        <i class="msg-act on" title="取消标记" onclick="event.stopPropagation();toggleMsgFlag(${m.session_id},${m.seq},'${tab}',this)">${tab === 'todo' ? '🚩' : '⭐'}</i>
      </div>
      <div class="flag-preview">${esc((m.preview || '').slice(0, 220))}${(m.preview || '').length > 220 ? '…' : ''}</div>
    </a>`).join('');
  return `${tabs}<div class="flag-list">${items}</div>`;
}

// ---------- 设置页：AI 助手网关 / 通用开关 / 运行状态 ----------

function renderSettings(cfg, hiddenSessions = [], corpses = []) {
  const { llm, status } = cfg;
  const keyPh = llm.apiKey.set
    ? `已保存 ${llm.apiKey.tail}（来源 ${llm.apiKey.source}），留空保持不变`
    : '未设置（不校验的网关可留空；也可放项目根 API_KEY.txt）';
  const dis = new Set(cfg.disabledAgents || []);
  const kv = (rows) => rows.map(([k, v]) =>
    `<div class="set-kv"><span>${k}</span><span title="${esc(v)}">${esc(v)}</span></div>`).join('');
  // 已隐藏会话行模板（前 HIDDEN_PREVIEW 条直接显示，其余折叠，避免几百行把"运行状态"顶到看不见）
  const HIDDEN_PREVIEW = 10;
  const hiddenRow = (s) => `
    <div class="set-hidden-row">
      ${agentBadge(s.agent)}
      <span class="set-hidden-title" title="${esc(s.title || '')}">${esc(s.title || '(无标题)')}</span>
      <span class="set-hidden-time">${fmtRange(s.created_at, s.updated_at)}</span>
      <button class="set-btn subtle" onclick="hideSession(${s.id}, false)">恢复显示</button>
    </div>`;
  return `
  <div class="settings-page">
    <div class="set-top">
      <button class="set-btn" onclick="exitSettings()" title="返回之前的视图（Esc 同效）">← 返回</button>
      <h2>设置</h2>
    </div>
    <div class="set-section">
      <h3>🤖 AI 助手（LLM 网关）</h3>
      <div class="set-field"><label>baseUrl</label><input id="set-baseurl" placeholder="http://localhost:11434/v1" value="${esc(llm.baseUrl)}"></div>
      <div class="set-field"><label>model</label><input id="set-model" placeholder="qwen3:32b" value="${esc(llm.model)}"></div>
      <div class="set-field"><label>apiKey</label><input id="set-apikey" type="password" placeholder="${esc(keyPh)}" autocomplete="new-password">${llm.apiKey.set && llm.apiKey.source === 'config' ? '<button class="set-btn subtle" onclick="clearLlmKey()" title="删除已保存在 config.json 的 key">清除</button>' : ''}</div>
      <div class="set-actions">
        <button class="set-btn primary" onclick="saveLlmCfg()">保存</button>
        <button class="set-btn" onclick="testLlm()">测试连接</button>
        <span id="llm-test-result" class="set-result"></span>
      </div>
      <div class="set-hint">OpenAI 兼容接口（Ollama / vLLM / LM Studio / 各类网关）。保存即生效，无需重启；环境变量 AE_LLM_* 优先于此处配置。</div>
    </div>
    <div class="set-section">
      <h3>⚙️ 通用</h3>
      <div class="set-field"><label>日志级别</label>
        <select id="set-loglevel">${['debug', 'info', 'warn', 'error'].map((l) => `<option value="${l}"${l === cfg.logLevel ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div class="set-field"><label>局域网访问</label>
        <label class="set-check"><input type="checkbox" id="set-lan"${cfg.lan ? ' checked' : ''}> 允许局域网设备访问（0.0.0.0；保存后需重启 serve 生效）</label>
      </div>
      <div class="set-field"><label>同步的 Agent</label>
        <div class="set-agents">${Object.entries(state.agentsMeta).map(([id, m]) =>
          `<label class="set-check"><input type="checkbox" class="set-agent" data-agent="${id}"${dis.has(id) ? '' : ' checked'}> ${esc(m.label)}</label>`).join('')}</div>
      </div>
      <div class="set-actions"><button class="set-btn primary" onclick="saveGeneralCfg()">保存</button><span id="gen-result" class="set-result"></span></div>
    </div>
    <div class="set-section">
      <h3>🧹 重试残骸会话</h3>
      ${corpses.length ? `
      <div class="set-hint">检测到 ${corpses.length} 个会话的全部用户消息都是"请继续"类重试词、没有任何真实提问——通常是 429 限流自动重试脚本反复"新建会话→重发"留下的空壳。隐藏后可在下方"已隐藏的会话"里恢复。</div>
      <div class="set-hidden">${corpses.slice(0, 8).map((s) => `
        <div class="set-hidden-row">
          ${agentBadge(s.agent)}
          <span class="set-hidden-title" title="${esc(s.title || '')}">${esc(s.title || '(无标题)')}</span>
          <span class="set-hidden-time">${fmtRange(s.created_at, s.updated_at)}</span>
        </div>`).join('')}</div>
      ${corpses.length > 8 ? `<div class="set-hint">…等共 ${corpses.length} 个</div>` : ''}
      <div class="set-actions"><button class="set-btn primary" onclick="cleanupCorpses()">一键隐藏（${corpses.length}）</button></div>`
      : '<div class="set-hint">未检测到重试残骸（判定标准：会话的全部用户消息都是"请继续"类重试词；只要有一条真实提问就保留）。</div>'}
      <div class="set-field"><label>自动清理</label>
        <label class="set-check"><input type="checkbox" id="set-autoclean"${cfg.autoHideRetryCorpses ? ' checked' : ''}> 同步发现新的重试残骸时自动隐藏</label>
      </div>
      <div class="set-actions"><button class="set-btn" onclick="saveGeneralCfg()">保存自动清理设置</button><span id="autoclean-result" class="set-result"></span></div>
    </div>
    <div class="set-section">
      <h3>🙈 已隐藏的会话${hiddenSessions.length ? `（${hiddenSessions.length}）` : ''}</h3>
      ${hiddenSessions.length ? `
      <div class="set-hidden">${hiddenSessions.slice(0, HIDDEN_PREVIEW).map(hiddenRow).join('')}</div>
      ${hiddenSessions.length > HIDDEN_PREVIEW ? `
      <details class="set-hidden-more"><summary>展开剩余 ${hiddenSessions.length - HIDDEN_PREVIEW} 条</summary>
        <div class="set-hidden">${hiddenSessions.slice(HIDDEN_PREVIEW).map(hiddenRow).join('')}</div>
      </details>` : ''}
      <div class="set-hint">隐藏的会话不出现在时间线 / 搜索 / 工作区 / 作息图与统计中；重同步不会自动恢复，仅在此手动恢复。</div>`
      : '<div class="set-hint">暂无隐藏的会话。悬停列表卡片右上角的 🙈 可隐藏测试对话等无关内容。</div>'}
    </div>
    <div class="set-section">
      <h3>📊 运行状态</h3>
      ${kv([
        ['版本', status.version || '-'],
        ['数据库', `${status.dbPath}（${status.dbSize}）`],
        ['数据目录', status.dataDir],
        ['配置文件', status.configPath],
        ['日志目录', status.logDir],
        ['监听', `:${status.port} @ ${status.host}`],
        ['PID', String(status.pid)],
      ])}
      ${cfg.lanRestartPending ? '<div class="set-warn">⚠️ 监听地址改动尚未生效：重启 serve（重新运行 start-chatvault.bat）后应用。</div>' : ''}
    </div>
  </div>`;
}

// 隐藏/恢复会话：列表卡片原地移除不打断滚动；详情页隐藏后返回列表；设置页刷新列表
window.hideSession = async (id, hidden, btn) => {
  try {
    await api.post('/api/session/hide', { session_id: id, hidden: !!hidden });
    toast(hidden ? '已隐藏（设置页可恢复）' : '已恢复显示');
    if (state.view === 'session' && state.sessionId === id) {
      if (hidden) goBack();
      else render();
    } else if (hidden && btn) {
      btn.closest('.session-card')?.remove();
    } else if (!hidden) {
      render();
    }
  } catch (e) { toast('操作失败：' + e.message); }
};

window.saveLlmCfg = async () => {
  const g = (id) => document.getElementById(id);
  try {
    const llmBody = { baseUrl: g('set-baseurl').value.trim(), model: g('set-model').value.trim() };
    const key = g('set-apikey').value.trim();
    if (key) llmBody.apiKey = key; // 留空 = 保持已有 key 不变
    await api.put('/api/config', { llm: llmBody });
    toast('已保存，即时生效');
    render();
  } catch (e) { toast('保存失败：' + e.message); }
};

window.clearLlmKey = async () => {
  try {
    await api.put('/api/config', { llm: { apiKey: '' } });
    toast('已清除 config.json 中的 apiKey');
    render();
  } catch (e) { toast('清除失败：' + e.message); }
};

window.testLlm = async () => {
  const g = (id) => document.getElementById(id);
  const el = g('llm-test-result');
  el.textContent = '测试中…';
  el.className = 'set-result';
  try {
    const body = { baseUrl: g('set-baseurl').value.trim(), model: g('set-model').value.trim() };
    const key = g('set-apikey').value.trim();
    if (key) body.apiKey = key;
    const r = await api.post('/api/config/test-llm', body);
    el.textContent = r.ok ? `✓ 连通 · ${r.model} · ${r.latencyMs}ms` : `✗ ${r.error}`;
    el.className = 'set-result ' + (r.ok ? 'ok' : 'bad');
  } catch (e) {
    el.textContent = '✗ ' + e.message;
    el.className = 'set-result bad';
  }
};

window.saveGeneralCfg = async () => {
  const g = (id) => document.getElementById(id);
  try {
    const disabled = [...document.querySelectorAll('.set-agent')].filter((c) => !c.checked).map((c) => c.dataset.agent);
    const r = await api.put('/api/config', {
      logLevel: g('set-loglevel').value,
      lan: g('set-lan').checked,
      disabledAgents: disabled,
      autoHideRetryCorpses: g('set-autoclean')?.checked ?? false,
    });
    const el = document.getElementById('autoclean-result');
    if (el) el.textContent = '已保存';
    toast(r.restartRequired ? '已保存；监听地址重启 serve 后生效' : '已保存');
  } catch (e) { toast('保存失败：' + e.message); }
};

// 一键隐藏重试残骸（预览在上方，隐藏后设置页"已隐藏的会话"可恢复）
window.cleanupCorpses = async () => {
  try {
    const r = await api.post('/api/cleanup/retry-corpses', {});
    toast(r.hidden ? `已隐藏 ${r.hidden} 个重试残骸会话` : '没有可清理的残骸');
    render();
  } catch (e) { toast('清理失败：' + e.message); }
};

function renderTimeline(sessions) {
  if (!sessions.length) return '<div class="empty">暂无会话，先运行 agent-exporter sync</div>';
  const byDay = new Map();
  for (const s of sessions) {
    const iso = (s.updated_at || s.created_at || '').slice(0, 10);
    if (!iso) continue;
    if (!byDay.has(iso)) byDay.set(iso, []);
    byDay.get(iso).push(s);
  }
  let html = '<div class="tl-top" id="tl-top"><div class="tl-bar" id="tl-bar"><canvas id="tl-canvas"></canvas><div class="tl-cursor" id="tl-cursor" style="display:none"></div><div class="tl-tip" id="tl-tip" style="display:none"></div></div></div>';
  for (const [iso, list] of byDay) {
    html += `<div class="day-header" id="day-${iso}">${esc(fmtDay(iso + 'T12:00:00'))}<span style="color:var(--fg-faint)">${list.length}</span></div>`;
    html += list.map((s) => renderSessionCard(s)).join('');
  }
  return html;
}

function renderSearchResults(results) {
  if (!results.length) return '<div class="empty">无匹配结果</div>';
  const cur = state.sort || 'hit';
  const tabs = [
    ['hit', '🎯 首次命中时间'], ['start', '▶ 对话开始时间'], ['end', '⏹ 对话结束时间'],
  ].map(([v, label]) =>
    `<button class="sort-tab${cur === v ? ' active' : ''}" onclick="setSearchSort('${v}')" title="按${label.slice(2)}倒序排列">${label}</button>`).join('');
  let html = `<div class="section-title">“${esc(state.query)}” — ${results.length} 个会话命中</div>
    <div class="sort-tabs">${tabs}</div>`;
  for (const r of results) {
    const icons = { user: '👤', assistant: '🤖', tool: '🔧', thinking: '💭' };
    const kw = state.query;
    const hits = r.hits.map((h) =>
      `<div class="hit-snippet" onclick="openSession(${r.session.id}, ${h.seq ?? h.messageId}, '${encJsStr(state.query)}')">${icons[h.role] || '·'} ${h.snippet}</div>`
    ).join('');
    // 首次命中时间线路（排序依据可视化）：与"共 N 条命中"合并为一行
    const firstLine = `<div class="hit-snippet first-hit">🎯 首次命中 <b>${fmtFull(r.firstHitAt)}</b>${r.lastHitAt && r.lastHitAt !== r.firstHitAt ? ` · 最后命中 <b>${fmtFull(r.lastHitAt)}</b>` : ''} · 共 ${r.totalHits} 条命中</div>`;
    // 点击卡片本身也定位到第一个命中消息并高亮关键词
    html += renderSessionCard(r.session, firstLine + hits, r.hits[0]?.seq ?? r.hits[0]?.messageId ?? null, kw);
  }
  return html;
}

window.setSearchSort = (s) => {
  if (!['hit', 'start', 'end'].includes(s)) return;
  prefSet('cv:search-sort', s); // 记住上次选择（下次无 URL 参数时沿用）
  navigate({ sort: s });
};

// ---------- 会话内搜索（Chrome Ctrl+F 风格：全部命中黄、当前命中橙） ----------
// 统一使用顶部搜索框：会话视图下输入 = 搜当前会话；▲▼/Enter 在命中间切换。

let lastDetail = null; // 当前会话详情
let sessSearch = { term: '', flat: [], idx: -1 }; // flat: 按序排列的 {range, msgId}

window.sessSearchRun = (term) => {
  const t = String(term ?? '').trim();
  // 同词重搜（如分页加载完成后的自动补扫）：保留用户已导航到的命中位置，
  // 否则刚打开深链就开始翻命中的人会被突然拽回第 1 条
  const resumeIdx = sessSearch.term === t ? sessSearch.idx : -1;
  sessSearch = { term: t, flat: [], idx: -1 };
  clearSearchHighlights();
  updateSearchNav();
  if (!sessSearch.term || !lastDetail) return;
  // 分页未完时先全量拉取再搜（搜索是低频操作；命中可能藏在未加载页）。
  // 注意还要等追加渲染队列排空：网络拉完 ≠ DOM 出图完毕，
  // 未渲染的消息没有元素，会被当成无命中
  if (!pageState.done && pageState.sessionId === state.sessionId) {
    loadAllPages();
    Promise.all([loadAllChain, appendChain]).then(() => {
      if (sessSearch.term === term.trim()) sessSearchRun(term);
    });
    updateSearchNav(); // 立即显示"加载中"状态
    return;
  }
  const kw = sessSearch.term.toLowerCase();
  // 超大消息（实测 1.9MB 思考块）：TreeWalker 建索引 + 逐词匹配 + Range 高亮
  // 会引发数百 ms 级强制布局，与展开/滚动叠加成布局风暴导致页面假死。
  // 只计数并滚动定位（range=null），跳过文本级高亮。
  const BIG_MSG_CHARS = 200_000;
  for (const m of lastDetail.messages) {
    if (!m.content_text || !textMatchesQuery(m.content_text, kw)) continue;
    // 消息锚点是会话内序号 seq（消息 id 随重同步变化，seq 才稳定）
    const el = document.getElementById(`msg-${m.seq}`);
    // 简要模式下 tool/system 折叠不渲染正文，命中只能计数定位（切回完整模式可见高亮）
    const collapsedSimple = state.simple && (m.role === 'tool' || m.role === 'system');
    if (!el || collapsedSimple) {
      // 兜底：数据在但元素没渲染出来 —— 保住计数与导航目标，不静默丢弃
      sessSearch.flat.push({ range: null, msgId: m.seq });
      if (sessSearch.flat.length >= 500) break;
      continue;
    }
    if (m.content_text.length > BIG_MSG_CHARS) {
      sessSearch.flat.push({ range: null, msgId: m.seq });
      if (sessSearch.flat.length >= 500) break;
      continue;
    }
    for (const range of buildFragRanges(el, { start: sessSearch.term })) {
      if (sessSearch.flat.length >= 500) break; // 上限保护
      sessSearch.flat.push({ range, msgId: m.seq });
    }
  }
  // 所有命中：黄色（超大消息无 range，仅计数）
  if (sessSearch.flat.length && CSS.highlights) {
    const rs = sessSearch.flat.map((h) => h.range).filter(Boolean);
    if (rs.length) CSS.highlights.set('ae-search', new Highlight(...rs));
  }
  updateSearchNav();
  if (!sessSearch.flat.length) return;
  if (resumeIdx > 0) {
    sessSearch.idx = Math.min(resumeIdx, sessSearch.flat.length - 1);
    sessSearchNav(0); // 原位重定位（不前进），保住用户浏览进度
  } else {
    sessSearchNav(1);
  }
};

/** 会话内搜索的文本匹配：与全局搜索（FTS5 unicode61）同语义。
 *  FTS 把标点当分隔符 —— 查询 here.now 实际匹配相邻词对 here→now，
 *  字面 includes('here.now') 却找不到，导致"列表说命中、进去无高亮"。
 *  实现：查询词转 [a-z0-9] 序列，词间用 [^a-z0-9]+ 连接成流式正则一次匹配。
 *  注意：绝不能逐词构建数组再双循环 —— 31 万词的消息会 OOM（实测 4GB 堆崩溃）。 */
let textMatchCache = null; // {lowerQuery, re} 同词复用正则
function textMatchesQuery(text, lowerQuery) {
  if (!text) return false;
  const qWords = lowerQuery.match(/[a-z0-9]+/g);
  if (!qWords || !qWords.length) return text.toLowerCase().includes(lowerQuery); // 纯 CJK/无词字符：字面匹配
  if (!textMatchCache || textMatchCache.lowerQuery !== lowerQuery) {
    const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 词间允许任意非 [a-z0-9] 字符（标点/空格/换行），与 unicode61 的分隔符语义一致
    textMatchCache = { lowerQuery, re: new RegExp(qWords.map(esc).join('[^a-z0-9]+'), 'i') };
  }
  return textMatchCache.re.test(text);
}

/** 超大文本专用匹配：与 textMatchesQuery 同语义但绝不分配词数组。
 *  用在超大消息上避免 OOM；普通消息走 textMatchesQuery（带正则缓存更快）。 */
function textMatchesQueryBig(text, lowerQuery) {
  return textMatchesQuery(text, lowerQuery); // 正则方案本身已是 O(1) 内存
}

// 导航令牌：快速连续点击时，上一次点击安排的延迟精确居中校正（双帧 rAF / 250ms 复核）
// 会晚于本次 scrollIntoView 执行，把视口又拉回上一个命中 —— 表现为两个命中来回跳。
// 只有最新一次导航允许执行校正，过期的直接作废
let sessNavToken = 0;

window.sessSearchNav = (dir) => {
  if (!sessSearch.flat.length) return;
  sessSearch.idx = (sessSearch.idx + dir + sessSearch.flat.length) % sessSearch.flat.length;
  const cur = sessSearch.flat[sessSearch.idx];
  const tk = ++sessNavToken;
  // 当前命中：橙色（独立 Highlight 层）；超大消息 range 为 null，只定位不高亮
  if (cur.range && CSS.highlights) {
    try { CSS.highlights.set('ae-search-cur', new Highlight(cur.range)); } catch { /* range 失效 */ }
  }
  const el = document.getElementById(`msg-${cur.msgId}`);
  if (el) {
    if (el.tagName === 'DETAILS') el.open = true; // 命中思考折叠块时展开
    if (!cur.range) {
      // 超大消息：展开 + 元素级滚动即可；跳过精确居中
      // （双帧 rAF + 定时复核的多次 getBoundingClientRect 会叠加成秒级卡顿）
      el.scrollIntoView({ block: 'start' });
      updateSearchNav();
      return;
    }
    // 先滚到消息元素（触发 content-visibility 区域渲染），再把命中文本精确居中：
    // 大消息元素盒可达数屏高，元素级 block:'center' 不能保证命中文本进入视口；
    // content-visibility 元素渲染后高度从占位值膨胀、scroll anchoring 会再偏移，
    // 故双帧后修正 + 250ms 后复核一次
    el.scrollIntoView({ block: 'center' });
    // 滚动容器是 #main（overflow-y:auto），不是 window
    const centerRange = () => {
      if (tk !== sessNavToken) return; // 已有更新的导航，过期校正作废
      try {
        const r = cur.range.getBoundingClientRect();
        if (r && (r.top < 60 || r.bottom > innerHeight - 60)) {
          const sc = document.getElementById('main') || document.scrollingElement;
          sc.scrollBy({ top: r.top + r.height / 2 - innerHeight / 2 });
        }
      } catch { /* range 已失效（重渲染） */ }
    };
    requestAnimationFrame(() => requestAnimationFrame(centerRange));
    setTimeout(centerRange, 250);
  }
  updateSearchNav();
};

window.sessSearchClose = () => {
  sessSearch = { term: '', flat: [], idx: -1 };
  clearSearchHighlights();
  updateSearchNav();
};

function clearSearchHighlights() {
  if (typeof CSS !== 'undefined' && CSS.highlights) {
    CSS.highlights.delete('ae-search');
    CSS.highlights.delete('ae-search-cur');
  }
}

/** 顶部搜索框右侧的 ▲▼ 导航与计数（仅会话视图且有命中时显示） */
function updateSearchNav() {
  const nav = document.getElementById('search-nav');
  if (!nav) return;
  const show = state.view === 'session' && sessSearch.term;
  nav.style.display = show ? 'flex' : 'none';
  const count = document.getElementById('ss-count');
  if (show) {
    count.textContent = sessSearch.flat.length
      ? `${sessSearch.idx + 1}/${sessSearch.flat.length}`
      : '无命中';
  }
}

/** 会话正文按批渲染：大会话（数千条）一次性 innerHTML 会卡数秒，
 *  分批 append 首屏立即可交互；锚点定位/搜索在渲染推进/完成时兜底。 */
let renderToken = 0;
/** 简要模式下 tool 消息的单行摘要 */
function toolBrief(m) {
  const t = m.content_text || '';
  if (m.role === 'system') {
    // Antigravity 系统消息：ℹ️ [Message] timestamp=… sender=… priority=… content=<正文>
    let brief = t.replace(/^\s*ℹ️\s*\[Message\]\s*/, '');
    const i = brief.indexOf('content=');
    if (i >= 0) brief = brief.slice(i + 8);
    return `⚙️ 系统 <span class="tool-brief-args">${esc(brief.slice(0, 160).replace(/\s+/g, ' ').trim())}</span>`;
  }
  const name = t.match(/^\[tool:([\w.:-]+)\]/)?.[1];
  if (name) {
    const args = t.slice(t.indexOf(']') + 1, 300).replace(/\s+/g, ' ').trim();
    return `🔧 ${esc(name)} <span class="tool-brief-args">${esc(args.slice(0, 120))}</span>`;
  }
  if (t.startsWith('[tool_result]')) {
    return `🔧 结果 <span class="tool-brief-args">${esc(t.slice(13, 160).replace(/\s+/g, ' ').trim())}</span>`;
  }
  return `🔧 ${esc(t.slice(0, 100).replace(/\s+/g, ' '))}`;
}

const TIME_GAP_MS = 2 * 3600 * 1000; // 会话内间隔 >2h 视为一次"断点续问"
function gapDivider(prev, cur) {
  if (!prev || !cur) return '';
  const t1 = Date.parse(prev.created_at || ''), t2 = Date.parse(cur.created_at || '');
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return '';
  const gap = t2 - t1;
  if (gap < TIME_GAP_MS) return '';
  const hrs = gap / 3600000;
  const label = hrs >= 48 ? `${Math.round(hrs / 24)} 天` : hrs >= 1 ? (hrs >= 10 ? `${Math.round(hrs)} 小时` : `${hrs.toFixed(1).replace(/\.0$/, '')} 小时`) : `${Math.round(gap / 60000)} 分钟`;
  return `<div class="gap-divider">⏸ 间隔 ${label} 后继续</div>`;
}

function renderMessageHTML(m, roleLabel, prevM) {
  return (() => {
    // 模型/思考等级徽标（assistant/thinking 才有）
    const badges = m.role === 'assistant' || m.role === 'thinking'
      ? `${m.model ? `<span class="model-tag">${esc(m.model)}</span>` : ''}${m.effort ? `<span class="model-tag effort">${esc(m.effort)}</span>` : ''}`
      : '';
    const acts = `<span class="msg-acts" data-seq="${m.seq}">
      <i class="msg-act${m.is_todo ? ' on' : ''}" title="标记 TODO" onclick="toggleMsgFlag(${state.sessionId},${m.seq},'todo',this)">🚩</i>
      <i class="msg-act${m.is_star ? ' on' : ''}" title="收藏" onclick="toggleMsgFlag(${state.sessionId},${m.seq},'star',this)">⭐</i>
      <i class="msg-act" title="复制链接" onclick="copyMsgLink(${state.sessionId},${m.seq})">🔗</i>
    </span>`;
    const meta = `<div class="msg-meta">${roleLabel[m.role] || m.role} ${badges}<span style="float:right">${acts}${fmtTimeT(m.created_at)}</span></div>`;
    const imgs = m.images?.length
      ? `<div class="msg-imgs">${m.images.map((f) =>
          `<img class="chat-img" src="/api/image?file=${encodeURIComponent(f)}" loading="lazy"
                onclick="showLightbox(this.src)" alt="对话图片">`).join('')}</div>`
      : '';
    if (m.role === 'thinking') {
      return `
      ${gapDivider(prevM, m)}
      <details class="msg thinking${state.simple ? ' simple' : ''}" id="msg-${m.seq}">
        <summary>${roleLabel[m.role]} · ${fmtTimeT(m.created_at)}
          <span class="msg-acts">
            <i class="msg-act${m.is_todo ? ' on' : ''}" title="标记 TODO" onclick="event.stopPropagation();event.preventDefault();toggleMsgFlag(${state.sessionId},${m.seq},'todo',this)">🚩</i>
            <i class="msg-act${m.is_star ? ' on' : ''}" title="收藏" onclick="event.stopPropagation();event.preventDefault();toggleMsgFlag(${state.sessionId},${m.seq},'star',this)">⭐</i>
            <i class="msg-act" title="复制链接" onclick="event.stopPropagation();event.preventDefault();copyMsgLink(${state.sessionId},${m.seq})">🔗</i>
          </span>
        </summary>
        <div class="thinking-body">${renderMarkdown(m.content_text)}</div>
      </details>`;
    }
    const body = m.role === 'tool'
      ? `<pre class="tool-text">${esc(m.content_text)}</pre>`
      : m.role === 'user'
        ? renderUserMessage(m.content_text)
        : renderMarkdown(m.content_text);
    const collapsed = state.simple && (m.role === 'tool' || m.role === 'system');
    return `
    ${gapDivider(prevM, m)}
    <div class="msg ${m.role}${collapsed ? ' simple' : ''}" id="msg-${m.seq}" ${collapsed ? `title="${esc((m.content_text || '').slice(0, 400))}"` : ''}>
      ${collapsed ? `<div class="msg-meta">${toolBrief(m)}<span style="float:right">${fmtTimeT(m.created_at)}</span></div>` : meta}
      ${collapsed ? '' : body}
      ${collapsed ? '' : imgs}
    </div>`;
  })();
}

// ---------- 会话链导航条（消息级引用树） ----------

function agentShort(agent) {
  return state.agentsMeta?.[agent]?.label || agent;
}

/** 递归渲染引用树节点。
 *  交互语义（2026-09-02 用户确认）：
 *   - ⏭ #seq 边 → 跳转到父会话里"发起引用"的那条消息（openSession(父id, seq)）
 *   - 会话 chip → 同样跳转到父会话的引用消息（与 ⏭ 一致）
 *   - 📂 按钮 → 打开该会话（唯一打开对话的入口）
 *  parentRef：{parentId, seq} 父会话的引用消息（chip 跳转目标）；根节点无 → 打开对话 */
function renderRefTreeNode(node, sid, depth, parentRef = null) {
  const s = node.session;
  if (!s) return '';
  const cur = s.id === sid;
  const indent = depth * 18;
  const kindIcon = (k) => k === 'continuation' ? '⏭' : '🔗';
  const children = node.children.map((c) => {
    // from_seq 是父会话（node.session.id）里的消息 seq
    const targetSeq = c.link.seq;
    const fromId = node.session.id;
    const jump = `openSession(${fromId}, ${targetSeq})`;
    return `
    <div class="ref-tree-child">
      <div class="ref-tree-edge">
        <span class="ref-tree-seq" title="跳转到 #${fromId} 的消息 #${targetSeq}（它引用了 #${c.link.to}）"
              onclick="${jump}">${kindIcon(c.link.kind)} #${targetSeq}</span>
        <span class="ref-tree-kind">${c.link.kind === 'continuation' ? '交接' : '参考'}${c.link.source === 'manual' ? '·手动' : ''}</span>
      </div>
      ${renderRefTreeNode(c.node, sid, depth + 1, { parentId: fromId, seq: targetSeq })}
    </div>`;
  }).join('');
  // chip 点击：有父引用 → 跳父会话的引用消息；根节点 → 打开对话
  const chipJump = parentRef ? `openSession(${parentRef.parentId}, ${parentRef.seq})` : `openSession(${s.id})`;
  const chipHref = parentRef ? `#/session/${parentRef.parentId}?msg=${parentRef.seq}` : `#/session/${s.id}`;
  return `
  <div class="ref-tree-node" style="margin-left:${indent}px">
    <div class="ref-tree-head">
      <a class="ref-tree-sess${cur ? ' cur' : ''}" href="${chipHref}"
         onclick="event.preventDefault();${chipJump}">
        ${esc(agentShort(s.agent))} #${s.id}${s.hidden ? ' 🙈' : ''}
        <span class="ref-tree-title">${esc((s.title || '').slice(0, 30))}</span>
      </a>
      <button class="ref-tree-open" onclick="openSession(${s.id})" title="打开对话 #${s.id}">📂</button>
    </div>
    ${children}
  </div>`;
}

/** 详情页链导航条：消息级引用树（当前会话 → 哪条消息引用了哪个会话 → 递归）。
 *  默认折叠成一行摘要（吸顶不占空间），点击展开完整树。
 *  支持双向：下游（我引用了谁）+ 上游（谁引用了我）。 */
let chainBarExpanded = false; // 展开状态（会话切换时保持）
let chainBarDirection = 'downstream'; // 'downstream' | 'upstream'

async function loadChainBar(sid) {
  const el = document.getElementById('chain-bar');
  if (!el) return;
  try {
    const tree = await api.get(`/api/sessions/${sid}/ref-tree?depth=3&direction=${chainBarDirection}`);
    const root = tree.session;
    if (!root) { el.innerHTML = `<span class="chain-label">⛓ 引用树</span><span class="chain-none">会话不存在</span>`; return; }
    const dirLabel = chainBarDirection === 'upstream' ? '被引用' : '引用';
    const dirToggle = chainBarDirection === 'upstream' ? 'downstream' : 'upstream';
    const dirBtn = `<button class="chain-link-btn" onclick="chainBarDirection='${dirToggle}';chainBarExpanded=true;loadChainBar(${sid})" title="切换方向">${chainBarDirection === 'upstream' ? '↓ 我引用的' : '↑ 被引用的'}</button>`;
    if (!tree.children.length) {
      const noneLabel = chainBarDirection === 'upstream' ? '暂无对话引用本会话' : '本会话未引用其他会话';
      el.innerHTML = `<span class="chain-label">⛓ ${dirLabel}</span><span class="chain-none">${noneLabel}</span>
        ${dirBtn}
        <button class="chain-link-btn" onclick="manualLink(${sid})" title="手动关联到另一个会话（如 A 让 B 接着做）">➕ 关联会话</button>`;
      return;
    }
    // 摘要：第一层
    const firstLevel = tree.children.map((c) => `${esc(agentShort(c.node.session?.agent))} #${c.link.to}`).join(' · ');
    const summary = `<span class="chain-label chain-toggle" title="点击展开引用树">⛓ ${dirLabel} ▸</span>
      <span class="chain-summary">${firstLevel}</span>
      ${dirBtn}
      <button class="chain-link-btn" onclick="manualLink(${sid})" title="手动关联到另一个会话">➕ 关联</button>
      <button class="chain-link-btn" onclick="chainUnlink(${sid})" title="解除与某个会话的关联">➖ 解除</button>
      <button class="chain-link-btn" onclick="reExtractLinks()" title="重新全量扫描用户消息，自动提取引用关系">♻ 重提取</button>`;
    const treeHtml = renderRefTreeNode(tree, sid, 0);
    const expanded = `<span class="chain-label chain-toggle" title="点击折叠引用树">⛓ ${dirLabel} ▾</span>
      <div class="ref-tree">${treeHtml}</div>
      ${dirBtn}
      <button class="chain-link-btn" onclick="manualLink(${sid})" title="手动关联到另一个会话">➕ 关联</button>
      <button class="chain-link-btn" onclick="chainUnlink(${sid})" title="解除与某个会话的关联">➖ 解除</button>
      <button class="chain-link-btn" onclick="reExtractLinks()" title="重新全量扫描用户消息，自动提取引用关系">♻ 重提取</button>`;
    el.innerHTML = chainBarExpanded ? expanded : summary;
    // 展开/收起统一由 label 切换
    el.querySelector('.chain-toggle')?.addEventListener('click', () => {
      chainBarExpanded = !chainBarExpanded;
      loadChainBar(sid);
    });
  } catch (e) {
    el.innerHTML = `<span class="chain-label">⛓ 引用树</span><span class="chain-none">加载失败</span>`;
  }
}

window.manualLink = async (sid) => {
  const to = prompt('关联到哪个会话？输入会话 id（数字）：');
  if (!to || !/^\d+$/.test(to.trim())) return;
  const note = prompt('备注（可选，如"让 B 继续推进"）：') || '';
  try {
    await api.post('/api/session/link', { from: sid, to: Number(to.trim()), note: note.trim() });
    toast(`已关联 #${sid} → #${to.trim()}`);
    loadChainBar(sid);
  } catch (e) { toast('关联失败：' + e.message); }
};

window.chainUnlink = async (sid) => {
  const to = prompt('解除与哪个会话的关联？输入会话 id（数字）：');
  if (!to || !/^\d+$/.test(to.trim())) return;
  try {
    await api.post('/api/session/unlink', { from: sid, to: Number(to.trim()) });
    toast(`已解除 #${sid} → #${to.trim()}`);
    loadChainBar(sid);
  } catch (e) { toast('解除失败：' + e.message); }
};

window.reExtractLinks = async () => {
  try {
    const r = await api.post('/api/links/re-extract', {});
    toast(`重提取完成：扫描 ${r.scanned} 条消息，建链 ${r.linked} 条`);
    if (state.view === 'session') loadChainBar(state.sessionId);
  } catch (e) { toast('重提取失败：' + e.message); }
};

function renderSessionDetail(detail) {
  const { session: s, messages } = detail;
  const roleLabel = { user: '👤 用户', assistant: '🤖 助手', tool: '🔧 工具', thinking: '💭 思考', system: '⚙️ 系统' };
  return `
  <div id="top-sentinel" style="height:1px"></div>
  <div class="session-top" id="session-top">
    <button class="back-btn" onclick="goBack()">⊞ 回列表</button>
    <div class="brand-inline" id="brand-inline" title="返回对话列表" onclick="goBack()" style="display:none"></div>
    <div class="session-head">
      <h2>${esc(s.title || '(无标题)')}</h2>
      <div class="session-meta">
        ${agentBadge(s.agent)}
        <span title="${esc(s.workspace_path || '')}">${esc(s.workspace_path || '未知工作区')}</span>
        <span>${fmtFull(s.created_at)} → ${fmtFull(s.updated_at)}</span>
        <span>${s.message_count || messages.length} 条消息${messages.length < (s.message_count || 0) ? '（滚动加载更多）' : ''}</span>
        ${s.hidden
          ? '<span class="hidden-badge" title="已隐藏的会话：不出现在列表/搜索/作息图中">🙈 已隐藏</span><button class="simple-toggle" onclick="hideSession(' + s.id + ', false)">👁 恢复</button>'
          : `<button class="simple-toggle" onclick="hideSession(${s.id}, true)" title="隐藏此会话：不出现在列表/搜索/作息图，设置页可恢复">🙈 隐藏</button>`}
        <button class="simple-toggle${state.simple ? ' on' : ''}" onclick="toggleSimple()" title="简要模式：折叠工具调用细节与思考，突出你的提问与助手回复">${state.simple ? '📋 简要' : '📄 完整'}</button>
      </div>
    </div>
    <div class="scrubber" id="scrubber" title="对话进度条：拖拽浏览；竖线为话题断点">
      <canvas class="scrub-canvas" id="scrub-canvas"></canvas>
      <div class="scrub-cursor" id="scrub-cursor"></div>
      <div class="scrub-tip" id="scrub-tip"></div>
    </div>
    <div class="chain-bar" id="chain-bar"><span class="chain-loading">⛓ 加载会话链…</span></div>
    ${umsgList.length ? `
    <div class="umsg-nav" id="umsg-nav">
      <button class="umsg-btn" onclick="umsgNav(-1)" title="上一条用户消息 (Alt+↑)">▲</button>
      <button class="umsg-cur" id="umsg-cur" onclick="umsgToggle()" title="展开全部用户消息清单">👤 -/-</button>
      <button class="umsg-btn" onclick="umsgNav(1)" title="下一条用户消息 (Alt+↓)">▼</button>
      <div class="umsg-panel" id="umsg-panel" style="display:none"></div>
    </div>` : ''}
  </div>
  <div id="msg-container">${messages.slice(0, BATCH_SIZE).map((m, i) => renderMessageHTML(m, roleLabel, messages[i - 1])).join('')}</div>`;
}

// ---------- 会话进度条（scrubber）----------
// 轨道按消息序号均匀映射：canvas 画每条消息的角色色刻度（自然呈现密度），
// 话题断点画竖线标记；游标随滚动同步；点击/拖拽跳转到对应消息。
let scrubState = { total: 0, gaps: [], seq: 0, dragging: false, cleanup: null };

const SCRUB_ROLE_COLOR = { user: 'var(--accent, #3b82f6)', assistant: '#3aa675', tool: '#666', thinking: '#8b5cf6', system: '#888' };

function initScrubber(detail) {
  const el = document.getElementById('scrubber');
  const canvas = document.getElementById('scrub-canvas');
  const cursor = document.getElementById('scrub-cursor');
  const tip = document.getElementById('scrub-tip');
  if (!el || !canvas) return;
  // 分页模式下 detail.messages 只有首屏：刻度/断点用全量 outline（seq/role/time 骨架）
  const msgs = (outlineCache?.length && outlineCache.length >= detail.messages.length)
    ? outlineCache : detail.messages;
  const total = msgs.length;
  if (!total) return;

  // 断点（>2h 间隔）位置：i 与 i-1 之间
  const gaps = [];
  for (let i = 1; i < msgs.length; i++) {
    const t1 = Date.parse(msgs[i - 1].created_at || ''), t2 = Date.parse(msgs[i].created_at || '');
    if (Number.isFinite(t1) && Number.isFinite(t2) && t2 - t1 >= TIME_GAP_MS) {
      const hrs = (t2 - t1) / 3600000;
      gaps.push({ at: i, label: hrs >= 48 ? Math.round(hrs / 24) + ' 天' : hrs >= 1 ? Math.round(hrs) + ' 小时' : Math.round((t2 - t1) / 60000) + ' 分钟' });
    }
  }

  // canvas 取 CSS 变量值（带 fallback）：var(--x, #abc) → 计算值或 #abc
  const css = (v) => {
    const m = /^var\(([^,)]+)(?:,\s*([^)]+))?\)$/.exec(v.trim());
    if (!m) return v;
    return getComputedStyle(document.documentElement).getPropertyValue(m[1].trim()).trim() || m[2]?.trim() || v;
  };
  const draw = () => {
    const w = el.clientWidth, h = 14;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const colors = { user: css(SCRUB_ROLE_COLOR.user), assistant: SCRUB_ROLE_COLOR.assistant, tool: '#5a5a5a', thinking: SCRUB_ROLE_COLOR.thinking, system: '#777' };
    for (let i = 0; i < total; i++) {
      const m = msgs[i];
      ctx.fillStyle = colors[m.role] || '#777';
      const x = Math.round((i / Math.max(total - 1, 1)) * (w - 2)) + 1;
      const hh = m.role === 'user' || m.role === 'assistant' ? h : Math.round(h * 0.55);
      ctx.fillRect(x, (h - hh) / 2, 1, hh);
    }
    // 断点标记：整高亮竖线
    ctx.fillStyle = 'rgba(255,180,60,.95)';
    for (const g of gaps) {
      const x = Math.round(((g.at - 0.5) / Math.max(total - 1, 1)) * (w - 2)) + 1;
      ctx.fillRect(x - 0.5, 0, 1.5, h);
    }
  };
  draw();
  const ro = new ResizeObserver(draw);
  ro.observe(el);

  // 滚动同步游标：视口顶部对应的消息序号
  const main = document.getElementById('main');
  let rafPending = false;
  const syncCursor = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (scrubState.dragging) return;
      const top = main.scrollTop + 80;
      // 二分：第一个 offsetTop >= top 的消息。
      // 只在已加载范围内二分：未加载页的消息没有 DOM 元素（offset 恒为 0），
      // 混进来会破坏单调性，把游标错误地推到 100%
      let lo = 0, hi = Math.min(total - 1, Math.max((pageState.loaded || total) - 1, 0));
      const offsetOf = (i) => document.getElementById('msg-' + msgs[i].seq)?.offsetTop ?? 0;
      // 缓存数组避免每帧查询（元素随分批渲染增加，逐次失效）
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsetOf(mid) < top) lo = mid + 1; else hi = mid;
      }
      scrubState.seq = lo;
      cursor.style.left = (lo / Math.max(total - 1, 1) * 100) + '%';
    });
  };
  main.addEventListener('scroll', syncCursor, { passive: true });

  // 指针交互：点击/拖拽 → 序号 → 滚动
  const posToSeq = (ev) => {
    const r = el.getBoundingClientRect();
    const pct = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
    return Math.round(pct * (total - 1));
  };
  const seqInfo = (i) => {
    const m = msgs[i] || {};
    const gapBefore = gaps.find((g) => g.at === i);
    const head = (m.content_text || '').replace(/\s+/g, ' ').slice(0, 60);
    return `#${i + 1}/${total} · ${m.role || ''} · ${m.created_at?.slice(5, 16) || ''}${gapBefore ? `<br>⏸ 此前间隔 ${gapBefore.label}` : ''}<br>${esc(head)}`;
  };
  const scrollToSeq = async (i) => {
    const target = document.getElementById('msg-' + msgs[i]?.seq);
    if (target) { main.scrollTop = target.offsetTop - 90; return; }
    // 目标消息未加载（分页尾部）：连续拉页直到覆盖目标 seq，再滚动定位
    const wantSeq = msgs[i]?.seq;
    let guard = 0;
    while (!pageState.done && guard++ < 200) {
      await fetchNextPage();
      const el2 = document.getElementById('msg-' + wantSeq);
      if (el2) { main.scrollTop = el2.offsetTop - 90; return; }
      if (pageState.fetching) continue; // fetchNextPage 内部已等待
    }
  };
  const onDown = (ev) => {
    scrubState.dragging = true;
    try { el.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件无有效 pointerId */ }
    const i = posToSeq(ev);
    scrubState.seq = i;
    cursor.style.left = (i / Math.max(total - 1, 1) * 100) + '%';
    tip.innerHTML = seqInfo(i);
    tip.style.display = 'block';
    tip.style.left = `min(max(${(i / Math.max(total - 1, 1)) * 100}%, 90px), calc(100% - 90px))`;
  };
  const onMove = (ev) => {
    if (!scrubState.dragging) return;
    const i = posToSeq(ev);
    scrubState.seq = i;
    cursor.style.left = (i / Math.max(total - 1, 1) * 100) + '%';
    tip.innerHTML = seqInfo(i);
    tip.style.left = `min(max(${(i / Math.max(total - 1, 1)) * 100}%, 90px), calc(100% - 90px))`;
  };
  const onUp = (ev) => {
    if (!scrubState.dragging) return;
    scrubState.dragging = false;
    tip.style.display = 'none';
    scrollToSeq(posToSeq(ev));
  };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', () => { if (!scrubState.dragging) tip.style.display = 'none'; });

  // hover 断点提示（非拖拽时）
  el.addEventListener('pointermove', (ev) => {
    if (scrubState.dragging) return;
    const r = el.getBoundingClientRect();
    const pct = (ev.clientX - r.left) / r.width;
    const near = gaps.find((g) => Math.abs((g.at - 0.5) / Math.max(total - 1, 1) - pct) < 0.01);
    if (near) {
      tip.innerHTML = `⏸ 话题断点：间隔 ${near.label} 后继续`;
      tip.style.display = 'block';
      tip.style.left = `min(max(${((near.at - 0.5) / Math.max(total - 1, 1)) * 100}%, 90px), calc(100% - 90px))`;
    } else if (tip.style.display === 'block' && !scrubState.dragging) tip.style.display = 'none';
  });

  scrubState.cleanup = () => {
    ro.disconnect();
    main.removeEventListener('scroll', syncCursor);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
  };
}

// ---------- 时间线工作密度条（顶部：每天一列，agent 堆叠，可拖拽跳日期） ----------
let tlBarState = { cleanup: null };

function initTimelineBar() {
  tlBarState.cleanup?.();
  const el = document.getElementById('tl-bar');
  const canvas = document.getElementById('tl-canvas');
  const cursor = document.getElementById('tl-cursor');
  const tip = document.getElementById('tl-tip');
  if (!el || !canvas) return;
  let alive = true;
  let dragging = false;
  let days = [], byDate = new Map(), hoursMap = {}, totalDays = 1, first = null, last = null, maxHour = 1;
  let agentOrder = []; // 全期消息量降序（tooltip 展示顺序）

  const DAY = 86400000;
  const parseD = (s) => new Date(s + 'T12:00:00');
  const dateOf = (i) => parseD(days[0].date).getTime() + i * DAY;
  const xOfIdx = (i, w) => (totalDays <= 1 ? w - 2 : (i / (totalDays - 1)) * (w - 2)) + 1;
  const idxOfPct = (pct) => Math.round(pct * (totalDays - 1));

  const params = new URLSearchParams();
  if (state.agent) params.set('agent', state.agent);
  if (state.workspaceIds.length) params.set('workspace_id', state.workspaceIds.join(','));
  api.get('/api/timeline-stats' + (params.toString() ? '?' + params.toString() : '')).then((data) => {
    if (!alive || !data.days?.length) return;
    days = data.days;
    hoursMap = data.hours || {};
    byDate = new Map(days.map((d) => [d.date, d]));
    first = parseD(days[0].date), last = parseD(days[days.length - 1].date);
    totalDays = Math.max(Math.round((last - first) / DAY) + 1, 1);
    maxHour = data.maxHour || 1;
    // agent 顺序：全期消息量降序（tooltip 展示顺序）
    const tot = new Map();
    for (const d of days) for (const [a, v] of Object.entries(d.byAgent)) tot.set(a, (tot.get(a) || 0) + v.messages);
    agentOrder = [...tot.entries()].sort((x, y) => y[1] - x[1]).map(([a]) => a);
    draw();
    syncCursor();
    cursor.style.display = 'block';
  }).catch(() => { /* 无数据时静默：条空着 */ });

  const css = (v) => {
    const m = /^var\(([^,)]+)(?:,\s*([^)]+))?\)$/.exec(v.trim());
    if (!m) return v;
    return getComputedStyle(document.documentElement).getPropertyValue(m[1].trim()).trim() || m[2]?.trim() || v;
  };
  const agentColor = (a) => state.agentsMeta[a]?.color || '#8a8a8a';
  const agentLabel = (a) => state.agentsMeta[a]?.label || a;

  const H_LABEL = 12; // 顶部月份标签区高度
  const draw = () => {
    if (!days.length) return;
    const w = el.clientWidth, h = el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const hCol = h - H_LABEL - 3;
    const colW = Math.max(Math.min((w - 4) / totalDays - 0.6, 10), 1.2);
    // 月份标签 + 周末底纹（跨整月范围逐日判断）
    let prevMonth = -1;
    ctx.font = '10px system-ui';
    ctx.textBaseline = 'top';
    for (let i = 0; i < totalDays; i++) {
      const dt = new Date(dateOf(i));
      const dow = dt.getDay();
      const x = xOfIdx(i, w);
      if (dow === 0 || dow === 6) { // 周末底纹：微亮背景列
        ctx.fillStyle = 'rgba(255,255,255,.035)';
        ctx.fillRect(x - colW / 2 - 0.5, H_LABEL, colW + 1, hCol + 3);
      }
      if (dt.getMonth() !== prevMonth) {
        prevMonth = dt.getMonth();
        ctx.fillStyle = 'rgba(255,255,255,.10)';
        ctx.fillRect(x - 0.5, H_LABEL - 2, 1, hCol + 5);
        ctx.fillStyle = css('var(--fg-faint, #777)');
        ctx.fillText(`${dt.getMonth() + 1}月`, x + 2, 0);
      }
    }
    // 作息网格：0-24 小时（顶部 0 点，底部 24 点），6/12/18 点参考线
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    for (const gh of [6, 12, 18]) {
      ctx.fillRect(0, H_LABEL + Math.round((gh / 24) * hCol), w, 1);
    }
    // 数据：每天一列，活跃小时画色块 —— 颜色 = 该小时主力 agent，亮度 = 消息强度
    // 列的轮廓即作息：从几点到几点、中间的空档一目了然
    const logMax = Math.log(1 + maxHour);
    for (const d of days) {
      const hd = hoursMap[d.date];
      if (!hd) continue;
      const i = Math.round((parseD(d.date) - first) / DAY);
      const x = xOfIdx(i, w);
      for (const [hs, cell] of Object.entries(hd)) {
        const hour = Number(hs);
        let dom = null, domN = 0;
        for (const [a, n] of Object.entries(cell.byAgent)) if (n > domN) { dom = a; domN = n; }
        if (!dom) continue;
        const alpha = 0.3 + 0.7 * (Math.log(1 + cell.total) / logMax); // 对数强度：亮 = 高强度小时
        ctx.globalAlpha = alpha;
        ctx.fillStyle = agentColor(dom);
        const y = H_LABEL + Math.round((hour / 24) * hCol);
        ctx.fillRect(x - colW / 2, y, colW, Math.max(Math.ceil(hCol / 24) - 0.3, 1));
      }
    }
    ctx.globalAlpha = 1;
  };
  const ro = new ResizeObserver(() => { draw(); });
  ro.observe(el);

  // 渲染出的日期分组锚点（列表为最近 200 条，可能是全范围子集）
  let dayAnchors = [];
  const collectAnchors = () => {
    dayAnchors = [...document.querySelectorAll('.day-header[id^="day-"]')]
      .map((n) => ({ iso: n.id.slice(4), top: () => n.offsetTop }));
  };
  collectAnchors();

  // 滚动 → 游标（视口顶部所在日期）
  const main = document.getElementById('main');
  let rafPending = false;
  const syncCursor = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (dragging || !dayAnchors.length || !days.length) return;
      const top = main.scrollTop + 120;
      let node = dayAnchors[0];
      for (const a of dayAnchors) { if (a.top() <= top) node = a; else break; }
      const i = Math.round((parseD(node.iso) - first) / DAY);
      cursor.style.left = xOfIdx(i, el.clientWidth) + 'px';
    });
  };
  main.addEventListener('scroll', syncCursor, { passive: true });

  // 悬停/拖拽提示
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const dayInfo = (i) => {
    const dt = new Date(dateOf(i));
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const d = byDate.get(iso);
    if (!d) return `${dt.getMonth() + 1}月${dt.getDate()}日 周${WEEK[dt.getDay()]}<br><span style="color:var(--fg-faint)">无会话</span>`;
    const lines = agentOrder.filter((a) => d.byAgent[a]?.messages).map((a) =>
      `<span style="color:${agentColor(a)}">●</span> ${esc(agentLabel(a))} · ${d.byAgent[a].sessions} 会话 / ${d.byAgent[a].messages} 条`);
    const hh = (n) => String(n).padStart(2, '0') + ':00';
    const schedule = d.firstHour != null
      ? `${hh(d.firstHour)} – ${hh(d.lastHour + 1)} · 活跃 ${d.activeHours} 小时`
      : '时间未知';
    const intensity = d.activeHours ? `强度 ≈ ${Math.round(d.messages / d.activeHours)} 条/活跃时` : '';
    return `<b>${dt.getMonth() + 1}月${dt.getDate()}日 周${WEEK[dt.getDay()]}</b><br>${schedule} · ${d.sessions} 会话 / ${d.messages} 条${intensity ? `<br>${intensity}` : ''}${lines.length ? '<br>' + lines.join('<br>') : ''}`;
  };
  const showTip = (i, clientX) => {
    tip.innerHTML = dayInfo(i);
    tip.style.display = 'block';
    const r = el.getBoundingClientRect();
    const x = xOfIdx(i, el.clientWidth);
    tip.style.left = `min(max(${x + r.left - r.left}px, 110px), calc(100% - 110px))`;
  };
  const posToIdx = (ev) => {
    const r = el.getBoundingClientRect();
    const pct = Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1);
    return idxOfPct(pct);
  };
  const isoOfIdx = (k) => {
    const dt = new Date(dateOf(k));
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  };
  const jumpTo = (i) => {
    const target = document.getElementById('day-' + isoOfIdx(i));
    if (target) { main.scrollTop = target.offsetTop - 60; return; }
    // 该日无分组（休息日等）：就近找有会话且已渲染的一天，并向用户说明落点
    for (let d = 1; d < totalDays; d++) {
      for (const k of [i - d, i + d]) {
        if (k < 0 || k >= totalDays) continue;
        const el2 = document.getElementById('day-' + isoOfIdx(k));
        if (el2) {
          main.scrollTop = el2.offsetTop - 60;
          const dt = new Date(dateOf(k));
          toast(`当日无会话，已定位到最近的 ${dt.getMonth() + 1}月${dt.getDate()}日`);
          return;
        }
      }
    }
  };
  const onDown = (ev) => {
    if (!days.length) return;
    dragging = true;
    try { el.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件无有效 pointerId */ }
    const i = posToIdx(ev);
    cursor.style.left = xOfIdx(i, el.clientWidth) + 'px';
    showTip(i, ev.clientX);
  };
  const onMove = (ev) => {
    if (!dragging || !days.length) return;
    const i = posToIdx(ev);
    cursor.style.left = xOfIdx(i, el.clientWidth) + 'px';
    showTip(i, ev.clientX);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    tip.style.display = 'none';
  };
  const onHover = (ev) => {
    if (dragging || !days.length) return;
    showTip(posToIdx(ev), ev.clientX);
  };
  const onLeave = () => { if (!dragging) tip.style.display = 'none'; };
  const onClick = (ev) => { if (days.length) jumpTo(posToIdx(ev)); };
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('mousemove', onHover);
  el.addEventListener('click', onClick);

  tlBarState.cleanup = () => {
    alive = false;
    ro.disconnect();
    main.removeEventListener('scroll', syncCursor);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('mousemove', onHover);
    el.removeEventListener('click', onClick);
    cursor.style.display = 'none';
    tip.style.display = 'none';
  };
}

const BATCH_SIZE = 300;
const PAGE_SIZE = 500; // 会话详情网络分页：首屏 500 条，滚动到尾部增量拉取
/** 分批渲染剩余消息（大会话渐进出图，可随时被新导航打断） */
function streamRestMessages(detail, onDone) {
  const token = ++renderToken;
  const container = document.getElementById('msg-container');
  if (!container) return;
  const roleLabel = { user: '👤 用户', assistant: '🤖 助手', tool: '🔧 工具', thinking: '💭 思考', system: '⚙️ 系统' };
  let i = Math.min(BATCH_SIZE, detail.messages.length);
  const BATCH_BYTES = 256 * 1024; // 单批字节上限：巨消息会话（平均数 KB/条）避免单帧布局数百 ms
  (function step() {
    if (token !== renderToken) return; // 已切换到其他视图/会话
    let html = '';
    const end = Math.min(i + BATCH_SIZE, detail.messages.length);
    for (; i < end; i++) {
      html += renderMessageHTML(detail.messages[i], roleLabel, detail.messages[i - 1]);
      if (html.length >= BATCH_BYTES && i + 1 < detail.messages.length) break;
    }
    if (html) container.insertAdjacentHTML('beforeend', html);
    if (i < detail.messages.length) requestAnimationFrame(step);
    else onDone?.();
  })();
}

// ---------- 会话详情增量分页 ----------
// 大会话（4.9 万条 / 48MB JSON）不再一次全量拉取：首屏 PAGE_SIZE 条，
// 滚动接近底部时按 offset 增量拉取下一页并追加渲染。
// outline（seq/role/time 骨架）一次性拿到，scrubber 与会话内搜索仍覆盖全量。
const pageState = {
  loaded: 0,      // 已加载消息数（= 下一次请求的 offset）
  total: 0,       // 会话总消息数（session.message_count）
  sessionId: null,
  fetching: false,
  done: false,    // 全部页已加载
};
let outlineCache = null; // 当前会话的消息骨架 [{seq, role, created_at}]

/** 追加渲染一页消息；返回渲染用的 prev 消息（衔接上一页末条）。
 *  全局串行链：深跳等场景会连续快速追加多页，若各页并行分批渲染，
 *  后页会顶掉前页未完成的批次（共享 renderToken）导致 DOM 出现永久空洞 */
let appendChain = Promise.resolve();
function appendPage(msgs) {
  const container = document.getElementById('msg-container');
  if (!container || !msgs.length) return;
  const roleLabel = { user: '👤 用户', assistant: '🤖 助手', tool: '🔧 工具', thinking: '💭 思考', system: '⚙️ 系统' };
  const BATCH_BYTES = 256 * 1024;
  const gtoken = renderToken; // 视图切换哨兵
  const prev0 = lastDetail?.messages?.[lastDetail.messages.length - msgs.length - 1];
  appendChain = appendChain.then(() => new Promise((done) => {
    let i = 0;
    (function step() {
      if (gtoken !== renderToken || !document.getElementById('msg-container')) return done();
      let html = '';
      const end = Math.min(i + BATCH_SIZE, msgs.length);
      for (; i < end; i++) {
        const prev = i === 0 ? prev0 : msgs[i - 1];
        html += renderMessageHTML(msgs[i], roleLabel, prev);
        if (html.length >= BATCH_BYTES && i + 1 < msgs.length) break;
      }
      if (html) container.insertAdjacentHTML('beforeend', html);
      if (i < msgs.length) requestAnimationFrame(step);
      else done();
    })();
  })).catch(() => {});
}

/** 拉取下一页；滚动触发时调用。单飞：已有在途请求时返回同一 Promise，
 *  保证 await fetchNextPage() 总是等到真实完成 —— 否则 while 循环会在
 *  微任务里无限自旋（守卫同步返回 → 立即重试），饿死网络回调导致页面卡死 */
let inflightFetch = null;
function fetchNextPage() {
  if (pageState.done || !pageState.sessionId || pageState.sessionId !== state.sessionId) {
    return Promise.resolve();
  }
  if (inflightFetch) return inflightFetch;
  pageState.fetching = true;
  inflightFetch = (async () => {
    try {
      const d = await api.get(`/api/sessions/${pageState.sessionId}?offset=${pageState.loaded}&limit=${PAGE_SIZE}`);
      if (pageState.sessionId !== state.sessionId) return; // 已切走
      if (!d.messages?.length) { pageState.done = true; return; }
      lastDetail.messages.push(...d.messages);
      pageState.loaded += d.messages.length;
      if (pageState.loaded >= pageState.total || d.messages.length < PAGE_SIZE) pageState.done = true;
      appendPage(d.messages);
    } catch { /* 网络失败：下次滚动重试 */ }
    finally { pageState.fetching = false; inflightFetch = null; }
  })();
  return inflightFetch;
}

/** 滚动监听：接近底部时预取下一页（提前 1500px 开始拉，掩盖网络延迟） */
function bindInfiniteScroll() {
  const main = document.getElementById('main');
  if (!main) return;
  main.addEventListener('scroll', () => {
    if (!pageState.sessionId || pageState.sessionId !== state.sessionId || pageState.done) return;
    const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 1500;
    if (nearBottom) fetchNextPage();
  }, { passive: true });
}

/** 拉取会话剩余所有页（会话内搜索前调用）。
 *  多个触发源（URL 预填 / 渲染完成重搜 / 用户输入）共享同一条加载链，
 *  链式串行避免并发循环；会话切换时旧链自然失效退出。 */
let loadAllChain = Promise.resolve();
function loadAllPages() {
  const sid = state.sessionId;
  loadAllChain = loadAllChain
    .then(async () => {
      while (!pageState.done && pageState.sessionId === sid && state.sessionId === sid) {
        await fetchNextPage();
      }
    })
    .catch(() => { /* 单页失败不阻断链 */ });
  return loadAllChain;
}

// ---------- 用户消息导航栏 ----------
// 会话吸顶区：▲▼ 在用户发言间快速跳转，中键展开全部用户消息清单（时间+摘要）。
// 大会话分页加载下，目标消息尚未渲染时按需补拉页面再定位；Alt+↑/↓ 同 ▲▼。
let umsgList = [];   // [{seq, created_at, brief, pos}] pos = 全量消息序（与 scrubber 同基准）
let umsgIdx = -1;    // 视口顶端所在的用户消息序（-1 = 尚在第一条之前）
let umsgScrollCleanup = null; // #main 常驻，重渲染时移除旧监听防堆积

/** 由 user-turns 接口结果构建导航数据；pos 基准与 initScrubber 的 msgs 选择保持一致 */
function prepareUmsg(turns) {
  const base = (outlineCache?.length && outlineCache.length >= (lastDetail?.messages?.length || 0))
    ? outlineCache : (lastDetail?.messages || []);
  const posOf = new Map(base.map((m, i) => [m.seq, i]));
  umsgList = (turns || []).map((t) => ({ ...t, pos: posOf.has(t.seq) ? posOf.get(t.seq) : Number.MAX_SAFE_INTEGER }));
  umsgIdx = -1;
}

/** 渲染后绑定：滚动同步计数 + 构建清单面板 */
function initUmsgNav() {
  const main = document.getElementById('main');
  if (!main || !umsgList.length) return;
  umsgScrollCleanup?.();
  let rafPending = false;
  const onScroll = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; updateUmsgCur(); });
  };
  main.addEventListener('scroll', onScroll, { passive: true });
  umsgScrollCleanup = () => main.removeEventListener('scroll', onScroll);
  buildUmsgPanel();
  updateUmsgCur();
}

/** 当前位置 = 离视口垂直中线最近的用户消息（跳转居中落点存在数十px 布局漂移，
 *  刀刃式阈值比较会被漂移卡住；最近距离判定对漂移免疫） */
function updateUmsgCur() {
  const cur = document.getElementById('umsg-cur');
  if (!cur || !umsgList.length) return;
  const main = document.getElementById('main');
  const centerLine = main.scrollTop + main.clientHeight / 2;
  let idx = -1, best = Infinity;
  for (let i = 0; i < umsgList.length; i++) {
    const el = document.getElementById('msg-' + umsgList[i].seq);
    if (!el) break; // 未加载页从这里开始，后面更不会有
    const d = Math.abs(el.offsetTop - centerLine);
    if (d < best) { best = d; idx = i; }
    if (el.offsetTop > centerLine) break; // 越过中线后距离只会越来越大
  }
  umsgIdx = idx;
  cur.textContent = `👤 ${idx + 1}/${umsgList.length}`;
}

function buildUmsgPanel() {
  const panel = document.getElementById('umsg-panel');
  if (!panel) return;
  panel.innerHTML = umsgList.map((t, i) => `
    <div class="umsg-item${i === umsgIdx ? ' cur' : ''}" onclick="umsgGo(${i})">
      <span class="umsg-i">${i + 1}</span>
      <span class="umsg-time">${fmtTimeT(t.created_at)}</span>
      <span class="umsg-brief">${esc(t.brief || '(无文本)')}</span>
    </div>`).join('');
}

window.umsgToggle = () => {
  const panel = document.getElementById('umsg-panel');
  if (!panel) return;
  const show = panel.style.display === 'none';
  panel.style.display = show ? 'block' : 'none';
  if (!show) return;
  buildUmsgPanel();
  panel.querySelector('.umsg-item.cur')?.scrollIntoView({ block: 'nearest' });
};

/** 定位到指定 seq 的消息；分页未覆盖时补拉页面，
 *  并等目标 offsetTop 连续两轮稳定（分批渲染/content-visibility 展开期间
 *  上方高度持续变化，过早滚动会被推离落点）再滚动居中 */
let umsgFlashEl = null;
async function jumpToSeq(seq) {
  let el = document.getElementById('msg-' + seq);
  if (!el) {
    const t = umsgList.find((x) => x.seq === seq);
    while (!el && t && Number.isFinite(t.pos)
           && !pageState.done && pageState.loaded <= t.pos
           && pageState.sessionId === state.sessionId) {
      await fetchNextPage();
      el = document.getElementById('msg-' + seq);
    }
    let lastTop = -1;
    for (let i = 0; i < 400; i++) { // 等渲染推进到目标且位置稳定（最长约 40s）
      el = document.getElementById('msg-' + seq);
      if (el && lastTop >= 0 && el.offsetTop === lastTop) break;
      lastTop = el ? el.offsetTop : -1;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!el) return;
  if (el.tagName === 'DETAILS') el.open = true;
  el.scrollIntoView({ block: 'center' });
  // 计数直接钉到目标：深跳后分批渲染仍在改动布局，滚动事件可能不再触发同步
  const ti = umsgList.findIndex((x) => x.seq === seq);
  if (ti >= 0) {
    umsgIdx = ti;
    const c = document.getElementById('umsg-cur');
    if (c) c.textContent = `👤 ${ti + 1}/${umsgList.length}`;
    buildUmsgPanel();
  }
  umsgFlashEl?.classList.remove('jump-flash');
  umsgFlashEl = el;
  void el.offsetWidth; // 重启动画
  el.classList.add('jump-flash');
  // 深跳后分批渲染/content-visibility 展开仍会改动布局、把目标推离落点，
  // 短周期复核将目标拉回视口中线，连续两轮稳定视为落定
  const mainEl = document.getElementById('main');
  let stable = 0, tries = 0;
  const settle = () => {
    tries++;
    const r = el.getBoundingClientRect();
    const mr = mainEl.getBoundingClientRect();
    const delta = (r.top + r.height / 2) - (mr.top + mr.height / 2);
    if (Math.abs(delta) > 60) { mainEl.scrollBy({ top: delta }); stable = 0; }
    else stable++;
    if (stable < 2 && tries < 20) setTimeout(settle, 150);
    else setTimeout(updateUmsgCur, 80);
  };
  setTimeout(settle, 120);
}

window.umsgGo = (i) => {
  if (i < 0 || i >= umsgList.length) return;
  umsgIdx = i;
  const panel = document.getElementById('umsg-panel');
  if (panel && panel.style.display !== 'none') window.umsgToggle();
  jumpToSeq(umsgList[i].seq);
};

window.umsgNav = (dir) => {
  if (!umsgList.length) return;
  updateUmsgCur(); // 以当前视口为准：下一条 = 视口之下的第一条，上一条 = 视口之上的最后一条
  const next = dir > 0
    ? Math.min(umsgIdx + 1, umsgList.length - 1)
    : Math.max(umsgIdx - 1, 0);
  if (next === umsgIdx && umsgIdx >= 0) return; // 已在端点且视口无变化
  umsgIdx = next;
  jumpToSeq(umsgList[next].seq);
};

// ---------- 图片 lightbox ----------

window.showLightbox = (src) => {
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.onclick = () => lb.classList.remove('show');
    document.body.appendChild(lb);
  }
  lb.innerHTML = `<img src="${src}" alt="">`;
  lb.classList.add('show');
};

/** 绑定会话内搜索条事件（每次会话渲染后调用） */
function bindSessSearch() {
  const input = document.getElementById('sess-search-input');
  if (!input) return;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => sessSearchRun(input.value), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if (input.value.trim() !== sessSearch.term) sessSearchRun(input.value);
      else sessSearchNav(e.shiftKey ? -1 : 1);
    }
  });
}

function renderWorkspaces(workspaces) {
  if (!workspaces.length) return '<div class="empty">暂无工作区</div>';
  return workspaces.map((w) => `
    <div class="session-card" onclick="filterWorkspace(${w.id})">
      <div class="session-title">📁 ${esc(w.name || w.path)}</div>
      <div class="session-meta"><span title="${esc(w.path)}">${esc(w.path)}</span></div>
      <div class="hit-snippet">${w.session_count} 个会话 · ${(w.agents || '').split(',').map((a) => esc(state.agentsMeta[a]?.label || a)).join(' / ')}${w.last_active ? ' · 最近 ' + esc(w.last_active.slice(0, 10)) : ''}</div>
    </div>`).join('');
}

// ---------- 文件预览面板（侧滑） ----------

window.openFile = (p, line) => {
  navigate({ preview: { path: p, line: line ? Number(line) : null } });
};
window.closePreview = () => navigate({ preview: null });
window.openInEditor = () => {
  if (!state.preview) return;
  const { path: p, line } = state.preview;
  window.open('vscode://file/' + p + (line ? ':' + line : ''), '_self');
};

function updatePreview() {
  let el = document.getElementById('file-preview');
  if (!state.preview) {
    if (el) el.remove();
    return;
  }
  const key = state.preview.path + ':' + (state.preview.line ?? 0);
  if (el && el.dataset.key === key) return; // 已在显示该文件
  if (!el) {
    el = document.createElement('div');
    el.id = 'file-preview';
    el.className = 'file-preview';
    document.body.appendChild(el);
  }
  el.dataset.key = key;
  el.innerHTML = `
    <div class="fp-head">
      <span class="fp-path" title="${esc(state.preview.path)}">${esc(state.preview.path)}${state.preview.line ? ` :${state.preview.line}` : ''}</span>
      <button class="fp-btn" onclick="openInEditor()" title="用 VS Code 打开">⬈ 编辑器</button>
      <button class="fp-btn" onclick="closePreview()" title="关闭 (Esc)">✕</button>
    </div>
    <div class="fp-body"><div class="fp-note">加载中…</div></div>`;

  const target = state.preview.line;
  fetch(`/api/file?path=${encodeURIComponent(state.preview.path)}`)
    .then(async (r) => ({ ok: r.ok, ...(await r.json()) }))
    .then((d) => {
      if (!el.dataset.key || el.dataset.key !== key) return; // 已切换到别的文件
      const body = el.querySelector('.fp-body');
      if (!d.ok) {
        body.innerHTML = `<div class="fp-note">❌ ${esc(d.error || '加载失败')}</div>`;
        return;
      }
      const rawUrl = `/api/raw?path=${encodeURIComponent(state.preview.path)}`;

      // 图片：内嵌显示，点击新标签看原图
      if (d.kind === 'image') {
        body.innerHTML = `<div class="fp-media"><a href="${rawUrl}" target="_blank" rel="noopener">
          <img src="${rawUrl}" alt="${esc(state.preview.path)}" loading="lazy"></a></div>`;
        return;
      }
      // PDF：浏览器内置查看器
      if (d.kind === 'pdf') {
        body.innerHTML = `<iframe class="fp-frame" src="${rawUrl}" title="pdf"></iframe>`;
        return;
      }
      // 音频 / 视频
      if (d.kind === 'audio' || d.kind === 'video') {
        body.innerHTML = `<div class="fp-media">${d.kind === 'video'
          ? `<video controls src="${rawUrl}"></video>`
          : `<audio controls src="${rawUrl}"></audio>`}</div>`;
        return;
      }
      // Markdown：复用消息区的渲染器（借 .msg 容器拿到同款样式）
      if (d.kind === 'markdown') {
        body.className = 'fp-body fp-md';
        body.innerHTML = `<div class="msg assistant">${renderMarkdown(d.content)}</div>`;
        return;
      }

      // 纯文本：行号 + 目标行高亮
      body.className = 'fp-body';
      const lines = d.content.split('\n');
      let from = 0, to = lines.length;
      if (lines.length > 4000 && target) { // 超大文件只渲染目标行附近窗口
        from = Math.max(0, target - 1500);
        to = Math.min(lines.length, target + 2500);
      }
      body.innerHTML =
        (from > 0 || to < lines.length ? `<div class="fp-note">显示第 ${from + 1}–${to} 行，共 ${lines.length} 行</div>` : '') +
        lines.slice(from, to).map((ln, i) => {
          const n = from + i + 1;
          return `<div class="fp-line${n === target ? ' target' : ''}" id="fpl-${n}"><span class="ln">${n}</span><code>${esc(ln)}</code></div>`;
        }).join('');
      if (target) {
        const t = body.querySelector(`#fpl-${target}`) || body.querySelector('.fp-line');
        t?.scrollIntoView({ block: 'center' });
      } else body.scrollTop = 0;
    })
    .catch((e) => {
      if (el.dataset.key === key) {
        el.querySelector('.fp-body').innerHTML = `<div class="fp-note">❌ ${esc(String(e))}</div>`;
      }
    });
}

// ---------- text fragment 高亮（:~:text= 前缀-,关键词,-后缀） ----------
// 浏览器原生 text fragment 无法作用于 SPA hash 路由，这里解析同款语法自行高亮。
// 优先 CSS Custom Highlight API（不破坏 DOM）；不支持时降级 <mark> 包裹。

const FRAG_HL_KEY = 'ae-frag';

/** 在元素内按片段创建高亮 Range 列表；带上下文时精确匹配一次，否则高亮所有出现 */
function buildFragRanges(root, frag) {
  // 超大容器（1.9MB 思考块等）：文本收集 + 逐词扫描 + Range 构建的代价会被
  // 后续每次强制布局反复放大，直接放弃精确高亮（调用方降级为仅定位）
  if (root.textContent && root.textContent.length > 200_000) return [];
  // 收集文本节点与累计偏移
  const texts = [];
  let full = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    texts.push({ node: n, start: full.length, text: n.nodeValue });
    full += n.nodeValue;
  }
  const makeRange = (from, to) => {
    if (from < 0 || to > full.length || to <= from) return null;
    const r = document.createRange();
    let done = false;
    for (const t of texts) {
      const s = Math.max(from, t.start);
      const e = Math.min(to, t.start + t.text.length);
      if (s < e) {
        if (!done) { r.setStart(t.node, s - t.start); done = true; }
        r.setEnd(t.node, e - t.start);
      }
    }
    return done ? r : null;
  };
  const ranges = [];
  if ((frag.prefix || frag.suffix) && frag.start) {
    const ctx = (frag.prefix || '') + frag.start + (frag.suffix || '');
    const idx = full.indexOf(ctx);
    if (idx >= 0) {
      const r = makeRange(idx + (frag.prefix || '').length, idx + (frag.prefix || '').length + frag.start.length);
      if (r) ranges.push(r);
    }
  }
  if (!ranges.length && frag.start) {
    const kw = frag.start.toLowerCase();
    const lower = full.toLowerCase();
    let i = lower.indexOf(kw);
    while (i >= 0 && ranges.length < 50) {
      const r = makeRange(i, i + frag.start.length);
      if (r) ranges.push(r);
      i = lower.indexOf(kw, i + kw.length);
    }
  }
  // 分词回退：查询含标点（如 here.now）时 FTS 按词序列匹配，字面 indexOf 找不到。
  // 用流式正则（词间任意非词字符）找到第一个"词序列出现"，整段高亮。
  // 注意：绝不能逐词建数组 —— 超大文本会 OOM（实测 31 万词 1.9MB 消息 4GB 堆崩溃）。
  if (!ranges.length && frag.start) {
    const qWords = frag.start.toLowerCase().match(/[a-z0-9]+/g);
    if (qWords && qWords.length > 1) {
      const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(qWords.map(esc).join('[^a-z0-9]+'), 'i');
      const mm2 = re.exec(full);
      if (mm2 && mm2.index >= 0) {
        const r = makeRange(mm2.index, mm2.index + mm2[0].length);
        if (r) ranges.push(r);
      }
    }
  }
  return ranges;
}

function applyTextFragment() {
  clearFragHighlight();
  if (!state.frag || !state.focusMsgId) return;
  const el = document.getElementById(`msg-${state.focusMsgId}`);
  if (!el) return;
  if (el.tagName === 'DETAILS') el.open = true;
  const ranges = buildFragRanges(el, state.frag);
  if (!ranges.length) return;
  if (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined') {
    CSS.highlights.set(FRAG_HL_KEY, new Highlight(...ranges));
  } else {
    // 降级：拆分文本节点包 <mark>
    for (const r of ranges.reverse()) {
      try {
        const mark = document.createElement('mark');
        r.surroundContents(mark);
      } catch { /* 跨节点时跳过 */ }
    }
  }
}

function clearFragHighlight() {
  if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(FRAG_HL_KEY);
}

// ---------- 渲染调度 ----------

/** 非会话视图下，工作区过滤激活时在内容顶部显示状态条（点击可取消） */
function withFilterChip(html) {
  const ids = state.workspaceIds;
  if (!ids.length || state.view === 'session') return html;
  const picked = ids.map((id) => allWorkspaces.find((x) => x.id === id)).filter(Boolean);
  if (!picked.length) return html;
  const label = picked.length === 1
    ? picked[0].path
    : `${picked[0].name || picked[0].path} 等 ${picked.length} 个工作区`;
  return `
  <div class="filter-bar">
    <span class="filter-chip" title="${esc(picked.map((w) => w.path).join('\n'))}">📁 ${esc(label)}
      <button class="clear-filter" title="取消工作区过滤" onclick="clearWsFilter()">✕</button>
    </span>
  </div>` + html;
}

let renderSeq = 0;
async function render() {
  scrubState.cleanup?.();
  scrubState.cleanup = null;
  tlBarState.cleanup?.();
  tlBarState.cleanup = null;
  syncControls();
  clearFragHighlight();
  clearSearchHighlights();
  updateSearchNav();
  updatePreview();
  const seq = ++renderSeq;
  try {
    if (state.view === 'session') {
      // 并行拉取：首屏消息（前 PAGE_SIZE 条）+ 全量骨架（scrubber/搜索定位用）+ 用户发言清单（导航栏）
      const [detail, outlineR, turnsR] = await Promise.all([
        api.get(`/api/sessions/${state.sessionId}?limit=${PAGE_SIZE}`),
        api.get(`/api/sessions/${state.sessionId}/outline`).catch(() => ({ outline: null })),
        api.get(`/api/sessions/${state.sessionId}/user-turns`).catch(() => ({ turns: [] })),
      ]);
      if (seq !== renderSeq) return;
      lastDetail = detail;
      outlineCache = outlineR.outline;
      prepareUmsg(turnsR.turns); // 需在 renderSessionDetail 前（导航栏 HTML 依赖 umsgList）
      // 分页状态初始化：total 优先用会话自述 message_count，outline 兜底
      pageState.sessionId = state.sessionId;
      pageState.loaded = detail.messages.length;
      pageState.total = detail.session.message_count || detail.messages.length;
      pageState.fetching = false;
      pageState.done = pageState.loaded >= pageState.total;
      $content.innerHTML = renderSessionDetail(detail);
      loadChainBar(state.sessionId); // 链导航条：异步加载当前会话所在链
      // 吸顶后收起次要信息（滚动离开顶部时只留返回按钮 + 标题）
      const sentinel = document.getElementById('top-sentinel');
      const top = document.getElementById('session-top');
      if (sentinel && top && 'IntersectionObserver' in window) {
        new IntersectionObserver(
          (es) => top.classList.toggle('stuck', !es[0].isIntersecting),
          {}
        ).observe(sentinel);
      }
      scrubState.cleanup?.();
      initScrubber(detail);
      initUmsgNav(); // 用户消息导航栏：滚动同步 + 清单面板
      bindInfiniteScroll(); // 滚动接近底部时增量拉取后续页
      // 锚点定位：首批已渲染则立即滚；否则等分批渲染推进到目标
      const focus = state.focusMsgId;
      let located = false;
      const locate = () => {
        if (located || focus == null) return located;
        const el = document.getElementById(`msg-${focus}`);
        if (el) {
          located = true;
          el.scrollIntoView({ block: 'center' });
          applyTextFragment(); // text fragment 高亮（定位消息内关键词）
        }
        return located;
      };
      if (!locate() && focus == null) { (() => { const sc = document.getElementById('main') || document.scrollingElement; sc.scrollTop = 0; })(); located = true; }
      // 会话内搜索：词 = 全局搜索词，无则用 text fragment 关键词兜底；
      // 搜索需覆盖全部消息，等分批渲染完成后再跑（首批命中的先由 sessSearchNav 兜底）
      const prefill = state.query || state.frag?.start || '';
      if (prefill) sessSearchRun(prefill);
      else updateSearchNav();
      streamRestMessages(detail, () => {
        if (seq !== renderSeq) return;
        locate();
        if (prefill && sessSearch.term === prefill) sessSearchRun(prefill); // 首屏渲染后重搜补齐
      });
      return;
    }
    if (state.query) {
      const params = new URLSearchParams({ q: state.query, limit: 50 });
      if (state.agent) params.set('agent', state.agent);
      if (state.workspaceIds.length) params.set('workspace_id', state.workspaceIds.join(','));
      params.set('sort', state.sort || 'hit');
      const [searchR, chainsR] = await Promise.all([
        api.get(`/api/search?${params}`),
        api.get('/api/chains?limit=2000').catch(() => ({ chains: [] })),
      ]);
      if (seq !== renderSeq) return;
      state.chainIds = new Set();
      for (const c of chainsR.chains || []) for (const s of c.sessions) state.chainIds.add(s.id);
      $content.innerHTML = withFilterChip(renderSearchResults(searchR.results));
      restoreListScroll();
      return;
    }
    if (state.view === 'flagged') {
      const tab = state.flagTab || 'todo';
      const { messages } = await api.get(`/api/flagged?flag=${tab}`);
      if (seq !== renderSeq) return;
      $content.innerHTML = renderFlagged(messages, tab);
      restoreListScroll();
      return;
    }
    if (state.view === 'workspaces') {
      const { workspaces } = await api.get('/api/workspaces');
      if (seq !== renderSeq) return;
      $content.innerHTML = renderWorkspaces(workspaces);
      restoreListScroll();
      return;
    }
    if (state.view === 'settings') {
      const [cfg, hid, corpses] = await Promise.all([
        api.get('/api/config'), api.get('/api/sessions/hidden'), api.get('/api/cleanup/retry-corpses'),
      ]);
      if (seq !== renderSeq) return;
      $content.innerHTML = renderSettings(cfg, hid.sessions || [], corpses.sessions || []);
      restoreListScroll();
      return;
    }
    // 全量加载（密度条可跳任意日期；列表卡片轻量，1461 条一次性渲染可控）
    const params = new URLSearchParams({ limit: 2000 });
    if (state.agent) params.set('agent', state.agent);
    if (state.workspaceIds.length) params.set('workspace_id', state.workspaceIds.join(','));
    const [{ sessions }, chainsR] = await Promise.all([
      api.get(`/api/sessions?${params}`),
      api.get('/api/chains?limit=2000').catch(() => ({ chains: [] })),
    ]);
    if (seq !== renderSeq) return;
    state.chainIds = new Set();
    for (const c of chainsR.chains || []) for (const s of c.sessions) state.chainIds.add(s.id);
    $content.innerHTML = withFilterChip(renderTimeline(sessions));
    restoreListScroll();
    initTimelineBar();
  } catch (err) {
    if (seq === renderSeq) $content.innerHTML = `<div class="empty">加载失败: ${esc(err.message)}</div>`;
  }
}

// ---------- 全局动作（供 inline onclick） ----------

window.toggleMsgFlag = async (sid, seq, kind, el) => {
  const value = !el?.classList.contains('on');
  try {
    await api.post('/api/message/flag', { session_id: sid, seq, kind, value });
    el?.classList.toggle('on', value);
  } catch (err) { toast('标记失败: ' + err.message); }
};
window.copyMsgLink = (sid, seq) => {
  const url = `${location.origin}${location.pathname}#/session/${sid}?msg=${seq}`;
  navigator.clipboard?.writeText(url).then(
    () => { toast('链接已复制'); },
    () => { prompt('复制消息链接：', url); }
  );
};
window.switchFlagTab = (tab) => navigate({ view: 'flagged', flagTab: tab, query: '', sessionId: null });
window.toggleSimple = () => {
  // 保留当前浏览位置：把游标对应的消息作为重渲染后的定位锚点（写入 URL msg 参数）
  // 校验 lastDetail/scrubState 属于当前会话，防跨会话残留取错锚点；
  // 分页模式下 scrubState.seq 对应 outline 全量序号，用 seq 直接定位消息
  const cur = (lastDetail?.session?.id === state.sessionId && scrubState.total === (outlineCache?.length || lastDetail?.messages?.length))
    ? { seq: outlineCache?.[scrubState.seq]?.seq ?? lastDetail.messages[scrubState.seq]?.seq } : null;
  const next = !state.simple;
  navigate({ simple: next, focusMsgId: cur?.seq ?? state.focusMsgId ?? null, frag: null });
  prefSet('cv:simple', next ? '1' : '0'); // 记住偏好：刷新/新标签/换会话都沿用
};

window.openSession = (id, focusMsgId = null, fragText = null) => {
  // 不清 query：从全局搜索进入时，会话内搜索条自动预填该词；
  // fragText 生成 text fragment（:~:text=），进入后关键词自动高亮
  // （fragText 由调用方 encodeURIComponent 编码，避免引号破坏 HTML 属性 / JS 字符串）
  let frag = null;
  if (fragText) {
    try { frag = { start: decodeURIComponent(fragText) }; } catch { frag = { start: fragText }; }
  }
  // 强制 push 历史：即使目标 hash 与当前相同（同会话内定位消息），
  // 也要 pushState 让浏览器前进/后退能回到上一个位置
  const prev = { ...state };
  Object.assign(state, { view: 'session', sessionId: id, focusMsgId, frag });
  onRouteChange(prev);
  syncControls();
  const hash = serializeState();
  if (location.hash === hash) {
    // 同 hash：仍 push 一条历史（同 URL 的 msg 定位），保证可后退
    history.pushState(null, '', hash);
    rerender(prev);
    return;
  }
  history.pushState(null, '', hash);
  rerender(prev);
};
window.goBack = () => {
  // 「返回」= 回到列表（保留进入会话前的搜索词/agent/工作区过滤）；
  // 浏览器后退键仍是标准历史回退（可逐步退回上一个会话/预览）
  navigate({ view: 'timeline', sessionId: null, focusMsgId: null, preview: null });
};
// 工作区过滤：与 Windows 资源管理器一致 —— 普通点击独占（再点唯一选中项取消）；
// Ctrl+点击 增删单项；Shift+点击 从锚点连选一段（Ctrl+Shift 在已有选择上叠加）。
// 锚点 = 最近一次普通/Ctrl 点击的项，按侧栏当前展示顺序取范围。
let wsAnchor = null;
window.filterWorkspace = (id, ev) => {
  const cur = state.workspaceIds;
  const ctrl = ev?.ctrlKey || ev?.metaKey;
  const shift = ev?.shiftKey;
  let next;
  if (shift && wsAnchor != null && wsAnchor !== id) {
    const order = [...document.querySelectorAll('.ws-item')].map((b) => Number(b.dataset.id));
    const ai = order.indexOf(wsAnchor);
    const ci = order.indexOf(id);
    if (ai >= 0 && ci >= 0) {
      const range = order.slice(Math.min(ai, ci), Math.max(ai, ci) + 1);
      next = ctrl ? [...new Set([...cur, ...range])] : range;
    } else {
      next = [id]; // 锚点不在当前列表（被过滤）：退化为独占选择
      wsAnchor = id;
    }
  } else if (ctrl) {
    next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    wsAnchor = id;
  } else {
    next = cur.length === 1 && cur[0] === id ? [] : [id];
    wsAnchor = id;
  }
  navigate({ view: 'timeline', workspaceIds: next, query: '', sessionId: null });
};
window.clearWsFilter = () => navigate({ workspaceIds: [] });

// ---------- 侧栏 / 过滤器 ----------

let allWorkspaces = [];
let wsFilter = '';

function renderWsList() {
  const kw = wsFilter.trim().toLowerCase();
  const match = (w) => !kw
    || (w.path || '').toLowerCase().includes(kw)
    || (w.name || '').toLowerCase().includes(kw);
  // 常规列表：有关键词时全库过滤；无关键词时只取最近活跃前 50
  const base = kw ? allWorkspaces.filter(match) : allWorkspaces.slice(0, 50);
  // 已选中但不在常规列表里的工作区置顶补显：URL 带 ws= 恢复的多选过滤
  // 大多不在"最近活跃前 50"里，不补显则刷新后看不到/无法单独取消这些选中项
  const baseIds = new Set(base.map((w) => w.id));
  const pickedPinned = state.workspaceIds
    .map((id) => allWorkspaces.find((w) => w.id === id))
    .filter((w) => w && !baseIds.has(w.id) && (kw ? match(w) : true));
  const cap = kw ? 200 : 50 + pickedPinned.length; // 补显行不计入默认窗口上限
  const shown = new Set();
  const rows = [];
  for (const w of [...pickedPinned, ...base].slice(0, cap)) {
    if (shown.has(w.id)) continue; // 置顶补显与常规列表去重
    shown.add(w.id);
    const active = state.workspaceIds.includes(w.id);
    rows.push(`
    <button class="ws-item ${active ? 'active' : ''}" data-id="${w.id}" onclick="filterWorkspace(${w.id}, event)"
            title="${active ? '点击取消' : '点击过滤'}；Ctrl+点击 多选，Shift+点击 连选\n${esc(w.path)}">
      <span class="cnt">${active ? (state.workspaceIds.length > 1 ? '✓' : '✕') : w.session_count}</span>${esc(w.name || w.path)}
    </button>`);
  }
  $wsList.innerHTML = rows.join('')
    + (allWorkspaces.length > shown.size ? `<div class="ws-more">…共 ${allWorkspaces.length} 个，输入关键词过滤</div>` : '');
}

async function initSidebar() {
  const [ws, st] = await Promise.all([api.get('/api/workspaces'), api.get('/api/stats')]);
  allWorkspaces = ws.workspaces;
  renderWsList();
  $statsBox.innerHTML = `${st.totals.sessions} 会话 · ${st.totals.messages} 消息<br>` +
    st.byAgent.map((a) => `${esc(state.agentsMeta[a.agent]?.label || a.agent)}: ${a.sessions}`).join('<br>');
  const wf = document.getElementById('ws-filter');
  let timer;
  wf.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { wsFilter = wf.value; renderWsList(); }, 120);
  });
}

function initAgentFilters() {
  $agentFilters.innerHTML = Object.entries(state.agentsMeta).map(([id, m]) =>
    `<button class="agent-chip" data-agent="${id}">${esc(m.label)}</button>`).join('');
  $agentFilters.querySelectorAll('.agent-chip').forEach((btn) => {
    btn.onclick = () => navigate({
      agent: state.agent === btn.dataset.agent ? null : btn.dataset.agent,
      // 设置是全局页：筛选没有作用对象，点 chip 带着筛选回时间线
      ...(state.view === 'settings' ? { view: 'timeline', sessionId: null } : {}),
    });
  });
}

// ---------- 启动 ----------

(async function init() {
  const { agents } = await api.get('/api/agents');
  state.agentsMeta = agents;
  initAgentFilters();
  initSidebar().then(() => { if (state.workspaceIds.length) render(); });

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.onclick = () => navigate({ view: btn.dataset.view, query: '', workspaceIds: [], sessionId: null });
  });
  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) settingsBtn.onclick = () => navigate(state.view === 'settings'
    ? { view: lastListView, query: '', workspaceIds: [], sessionId: null } // 齿轮再点一次 = 退出
    : { view: 'settings', query: '', workspaceIds: [], sessionId: null });
  // 设置页 Esc = 返回（页内搜索框此时已隐藏，无冲突）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.view === 'settings') exitSettings();
  });
  const brand = document.getElementById('brand');
  if (brand) brand.onclick = () => goBack(); // 会话详情中点击品牌 = 返回列表

  let timer;
  // 统一搜索框：列表视图 = 全局搜索；会话视图 = 会话内搜索（Chrome Ctrl+F 式）
  $search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = $search.value.trim();
      if (state.view === 'session') {
        sessSearchRun(v);
        // 词变化后旧的定位消息/片段不再适用
        navigate({ query: v, focusMsgId: null, frag: null }, { replace: true });
      } else if (state.view === 'settings') {
        // 设置是全局页：搜索没有作用对象，跳到时间线执行全局搜索
        navigate({ query: v, view: 'timeline', sessionId: null, focusMsgId: null, frag: null }, { replace: true });
      } else {
        navigate({ query: v }, { replace: true });
      }
    }, 250);
  });
  $search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      e.preventDefault();
      const v = $search.value.trim();
      if (state.view === 'session') {
        // 会话内：Enter/Shift+Enter 在命中间切换；改了词则先搜索
        if (v !== sessSearch.term) sessSearchRun(v);
        else sessSearchNav(e.shiftKey ? -1 : 1);
      } else {
        navigate({ query: v, view: 'timeline', sessionId: null, focusMsgId: null, frag: null, preview: null });
      }
    }
    if (e.key === 'Escape' && e.target === $search) {
      $search.value = '';
      if (state.view === 'session') {
        sessSearchClose();
        navigate({ query: '' }, { replace: true });
      } else if (state.query) {
        navigate({ query: '' }, { replace: true });
      }
    }
  });
  document.getElementById('ss-prev')?.addEventListener('click', () => sessSearchNav(-1));
  document.getElementById('ss-next')?.addEventListener('click', () => sessSearchNav(1));

  // 初始状态从 URL 还原
  Object.assign(state, parseHash());
  syncControls();
  render();

  // 文件链接点击 → 工具内预览（事件委托，覆盖所有动态渲染的消息）
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a.file-link');
    if (!a) return;
    e.preventDefault();
    openFile(a.dataset.path, a.dataset.line);
  });
  // Esc 分层关闭：图片放大 > 文件预览 > 会话内搜索；Alt+↑/↓ 在用户消息间跳转
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); window.umsgNav?.(-1); return; }
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); window.umsgNav?.(1); return; }
    if (e.key !== 'Escape') return;
    const lb = document.getElementById('lightbox');
    if (lb?.classList.contains('show')) { lb.classList.remove('show'); return; }
    if (state.preview) { closePreview(); return; }
    if (state.view === 'session' && sessSearch.term) {
      sessSearchClose();
      $search.value = '';
      navigate({ query: '' }, { replace: true });
    }
  });
})();

// ---------- AI 助手（对话库检索 agent） ----------
(() => {
  const drawer = document.getElementById('ai-drawer');
  const fab = document.getElementById('ai-fab');
  const msgs = document.getElementById('ai-msgs');
  const input = document.getElementById('ai-input');
  const send = document.getElementById('ai-send');
  let history = []; // [{role, content}] 多轮上下文
  let busy = false;
  let abortCtl = null;

  const toggle = (show) => {
    const on = show ?? !drawer.classList.contains('open');
    drawer.classList.toggle('open', on);
    if (on) { restoreHistory(); input.focus(); }
  };
  fab.addEventListener('click', () => toggle(true));
  document.getElementById('ai-close').addEventListener('click', () => toggle(false));
  document.getElementById('ai-clear').addEventListener('click', () => {
    history = [];
    msgs.innerHTML = '';
  });

  // 刷新/重开后从服务端归档恢复历史对话，并重建多轮上下文（最近 4 组问答）
  let restored = false;
  async function restoreHistory() {
    if (restored) return;
    restored = true;
    try {
      const { chats } = await api.get('/api/ai/history?limit=20');
      const frag = [];
      for (const c of chats) {
        if (c.question) frag.push(`<div class="ai-msg user">${esc(c.question)}</div>`);
        if (c.steps?.length) frag.push(`<div class="ai-msg process">${c.steps.map((s) => `<div class="ai-step">🔍 ${esc(s)}</div>`).join('')}</div>`);
        if (c.answer) frag.push(`<div class="ai-msg bot${c.status === 'error' ? ' err' : ''}">${linkify(renderMarkdown(c.answer))}</div>`);
        else if (c.status === 'aborted') frag.push('<div class="ai-msg process"><div class="ai-step">⏹ 已中断</div></div>');
        if (c.question && c.answer && c.status === 'done') {
          history.push({ role: 'user', content: c.question }, { role: 'assistant', content: c.answer });
        }
      }
      history = history.slice(-8);
      if (frag.length) {
        msgs.insertAdjacentHTML('afterbegin', frag.join(''));
        msgs.scrollTop = msgs.scrollHeight;
      }
    } catch { /* 无历史或接口失败时静默 */ }
  }

  const addMsg = (html, cls) => {
    const div = document.createElement('div');
    div.className = 'ai-msg ' + cls;
    div.innerHTML = html;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  };

  // 回答里的 #/session/<id> 与 session_id 数字转可点击链接
  const linkify = (html) => html
    .replace(/#\/session\/(\d+)/g, '<a class="ai-link" href="#/session/$1">会话 #$1</a>')
    .replace(/(?:^|[^\w#])(?:session[_ ]?id[=:： ]*|会话\s*#?)(\d{2,7})/g, '$1<a class="ai-link" href="#/session/$1">↗</a>');

  async function ask() {
    const q = input.value.trim();
    if (!q || busy) return;
    busy = true;
    input.value = '';
    abortCtl = new AbortController();
    send.textContent = '⏹';
    send.title = '停止';
    addMsg(esc(q), 'user');
    const proc = addMsg('<span class="ai-dot">●●●</span>', 'process');
    const steps = [];
    let answer = '', error = '';
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, history }),
        signal: abortCtl.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 2);
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') continue;
          let ev;
          try { ev = JSON.parse(payload); } catch { continue; }
          if (ev.type === 'tool') {
            steps.push(ev.brief);
            proc.innerHTML = steps.map((s) => `<div class="ai-step">🔍 ${esc(s)}</div>`).join('') + '<span class="ai-dot">●●●</span>';
            msgs.scrollTop = msgs.scrollHeight;
          } else if (ev.type === 'answer') {
            answer = ev.content;
          } else if (ev.type === 'error') {
            error = ev.message;
          } else if (ev.type === 'aborted') {
            error = '__aborted__';
          }
        }
      }
    } catch (err) {
      error = err.name === 'AbortError' ? '__aborted__' : err.message;
    }
    // 保留检索步骤（去动画），供用户回看过程
    proc.querySelectorAll('.ai-dot').forEach((d) => d.remove());

    if (answer) {
      addMsg(linkify(renderMarkdown(answer)), 'bot');
      history.push({ role: 'user', content: q }, { role: 'assistant', content: answer });
      history = history.slice(-8);
    } else if (error === '__aborted__') {
      // 用户中断：保留已显示的检索步骤，不写入对话历史
    } else {
      addMsg(`⚠️ ${esc(error || '未获得回答')}`, 'bot err');
    }
    busy = false;
    abortCtl = null;
    send.textContent = '➤';
    send.title = '发送';
    input.focus();
  }

  send.addEventListener('click', () => {
    if (busy) { abortCtl?.abort(); return; } // 生成中点击 = 停止
    ask();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask();
  });
})();
