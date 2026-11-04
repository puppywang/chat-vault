// Synthetic extension APIs for the isolated Chrome popup test only.
(() => {
  const cid = '11111111-1111-4111-8111-111111111111';
  const tid = '01a0c40e-6e82-7033-8301-b436bf06d0ad';
  const errors = [];
  addEventListener('error', event => errors.push(event.message));
  addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  const state = { opened: [], requests: [], response: null, savedLookup: null };
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.13.0' }), sendMessage: async () => ({ ok: true }) },
    storage: { onChanged: { addListener() {} }, local: {
      get: async defaults => ({ ...(typeof defaults === 'object' ? defaults : {}),
        auto: false, syncEnabled: false, injectionEnabled: true,
        codexLookupHistory: state.savedLookup ? [state.savedLookup] : [] }), set: async () => {} } },
    tabs: { query: async () => [{ id: 1, url: `https://chatgpt.com/c/${cid}` }],
      get: async () => ({ id: 1, url: `https://chatgpt.com/c/${cid}` }),
      create: async value => { state.opened.push(value); },
      sendMessage: async (_id, message) => {
        if (message.type === 'diagnosticProbe') return { page_runtime: { version: '0.13.0', phase: 'ready' },
          conversation_mode: { mode: 'mixed', turns: 12, workTurns: 10, chatTurns: 2, lastTurn: 'chat' } };
        state.requests.push(message); return state.response;
      } },
  };
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const get = id => document.getElementById(id);
  const flush = () => new Promise(resolve => setTimeout(resolve, 30));
  const candidate = overrides => ({ threadId: tid, confidence: 'verified', matchedBy: 'user-message-id',
    matchedUserMessageId: cid, ...overrides });
  const result = (candidates, overrides = {}) => ({ ok: true, lookupVersion: '0.13.0', conversationId: cid,
    candidates, requiresConfirmation: candidates.length !== 1, ...overrides });
  addEventListener('load', async () => {
    const checks = [];
    try {
      await flush();
      assert(get('convMode').textContent.includes('混合') && get('convMode').textContent.includes('10 轮 Work'), 'conversation mode not shown');
      assert(!get('codexThread').hidden, 'Codex entry hidden for a Work/mixed conversation');
      assert(get('codexThreadDeep').hidden, 'deep lookup offered before a normal lookup');
      assert(get('codexExport') == null && get('capture') == null, 'removed entries still present');
      checks.push('conversation mode shown without extra requests; removed entries absent');
      assert(!get('codexThread').disabled && !get('codexThreadDeep').disabled, 'lookup disabled when sync paused');
      assert(get('sync').disabled, 'sync should remain paused');
      state.response = result([candidate()]);
      get('codexThread').click(); await flush();
      assert(state.opened.length === 1 && state.opened[0].url === `https://chatgpt.com/local/${tid}?hostId=local`, 'exact URL');
      checks.push('verified identity opens exact URL');
      state.response = result([candidate({ confidence: 'candidate', matchedBy: 'first-user-message' })], { requiresConfirmation: true });
      get('codexThread').click(); await flush();
      assert(state.opened.length === 1, 'weak match opened automatically');
      assert(get('codexThreadCandidates').children.length === 1, 'weak candidate not displayed');
      get('codexThreadCandidates').firstElementChild.click(); await flush();
      assert(state.opened.length === 2, 'explicit candidate selection failed');
      checks.push('weak singleton requires selection');
      state.response = result([], { status: 'route-unsupported', message: '当前入口不支持 placement 格式。',
        diagnostics: { scope: 'association', sonicCount: 28, sampleCount: 3, failures: [],
          probes: [{ state: 'route-unsupported', reason: 'placement version 3' }] } });
      get('codexThread').click(); await flush();
      assert(state.opened.length === 2, 'unverified Sonic opened automatically');
      assert(get('codexThreadStatus').textContent.includes('placement'), 'route refusal hidden');
      assert(get('codexThreadDiagnostics').textContent.includes('未扫描全量历史'), 'wrong scope');
      checks.push('unsupported association route displayed without navigation');

      state.response = result([], { status: 'paused', canContinue: true, message: '本批暂停，进度已保留。',
        diagnostics: { scope: 'history', rootsListed: 9, rootsChecked: 9, rootsCompleted: 3, rootsPending: 6,
          itemPages: 238, totalItemPages: 238, partial: true, paused: true, canContinue: true, failures: [] } });
      get('codexThreadDeep').click(); await flush();
      assert(get('codexThreadDeep').textContent.includes('继续查找'), 'resume action missing');
      assert(get('codexThreadStatus').textContent.includes('进度已保留'), 'pause shown as failure');
      assert(get('codexThreadDiagnostics').textContent.includes('已完成 3/9'), 'started roots counted as complete');
      assert(!get('codexThreadDiagnostics').textContent.includes('读取失败'), 'budget counted as RPC failure');
      checks.push('budget pause offers continuation and accurate completed count');
      state.response = result([candidate(), candidate({ threadId: '01a0ce5b-5fcd-7352-9c6f-1fb93a8bcedc' })], {
        diagnostics: { scope: 'history', rootsListed: 9, rootsChecked: 9, rootsCompleted: 9, rootsPending: 0,
          itemPages: 12, partial: false, failures: [] } });
      get('codexThreadDeep').click(); await flush();
      assert(state.requests.at(-1).deepScan === true, 'deep scan mode missing');
      assert(state.opened.length === 2 && get('codexThreadCandidates').children.length === 2, 'multi-match auto-opened');
      assert(get('codexThreadDiagnostics').textContent.includes('9/9'), 'coverage missing');
      for (const button of get('codexThreadCandidates').children)
        assert(button.scrollWidth <= button.clientWidth + 1, 'thread ID overflowed button');
      checks.push('deep multi-thread selection, coverage and wrapping');
      state.response = result([candidate()], { lookupVersion: '0.11.3' });
      get('codexThread').click(); await flush();
      assert(state.opened.length === 2 && get('codexThreadStatus').textContent.includes('刷新'), 'old module not rejected');
      checks.push('old page module rejected');
      state.response = { ok: false, lookupVersion: '0.13.0', code: 'LOOKUP_INCOMPLETE', error: '查找未完成：429',
        diagnostics: { scope: 'history', rootsListed: 9, rootsChecked: 4, itemPages: 3, partial: true, failures: [{ code: 429 }] } };
      get('codexThreadDeep').click(); await flush();
      assert(get('codexThreadStatus').textContent.includes('429'), 'failure reason hidden');
      assert(get('codexThreadDiagnostics').textContent.includes('不能据此排除'), 'incomplete scope hidden');
      checks.push('read failure not misreported as absence');
      assert(errors.length === 0, 'browser errors: ' + errors.join('; '));
      const pre = document.createElement('pre'); pre.id = 'result';
      pre.textContent = JSON.stringify({ ok: true, checks, errors }); document.body.append(pre);
    } catch (error) {
      const pre = document.createElement('pre'); pre.id = 'result';
      pre.textContent = JSON.stringify({ ok: false, error: error.message, checks, errors }); document.body.append(pre);
    }
  });
})();
