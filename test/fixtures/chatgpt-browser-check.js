(async () => {
  const checks = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (ok, name) => { if (!ok) throw new Error(name); checks.push(name); };
  try {
    await __cvPage.ready;
    // Ordinary /c/ pages now reuse the page's own fetch. The old fixture only
    // mocked extension-side downloads, leaving the current bridge with no data.
    await fetch(`/backend-api/conversation/${fixture.id}`);
    await wait(fixture.staged ? 2200 : 350);
    check(__cvPage.snapshot().phase === 'ready', 'page lifecycle ready');
    const status = __cvTurns.status();
    check(status.loop_active && status.elapsed_ms >= 59000, 'cold start restores server start time, not 0.0');
    check(__cvSpeed.snapshot().ttftReason === '缺少原始起点', 'refreshed round does not wait for an original request that preceded this page');
    const first = document.querySelector('#cv-turn-timer');
    const label = first.shadowRoot.getElementById('v').textContent;
    await wait(1200);
    check(first.shadowRoot.getElementById('v').textContent !== label, 'real timer ticks');

    first.remove();
    await wait(1200);
    check(document.querySelector('#cv-turn-timer') && __cvTurns.status().loop_active, 'detached timer host is recreated');
    await chrome.storage.local.set({ durations: false });
    await wait(50);
    check(!document.querySelector('#cv-turn-timer') && !__cvTurns.status().loop_active, 'duration switch stops and removes timer');
    check(__cvSpeed.status().enabled, 'speed collection independent of duration UI');
    await chrome.storage.local.set({ durations: true });
    await wait(50);
    check(__cvTurns.status().elapsed_ms >= 61000, 'reenabling duration does not reset round time');

    __cvSpeed.hydrate = async () => { throw new Error('fixture tokenizer failure'); };
    await refreshTurns(); await wait(50);
    check(!!document.querySelector('#cv-turn-panel'), 'speed failure does not suppress history panel');
    check(document.querySelectorAll('.cv-turn-host').length > 0, 'real message anchor receives start badge');

    // A completed assistant image is an anchor too; it must receive an end badge.
    document.querySelector('[data-testid="stop-button"]').remove();
    const assistant = document.createElement('div');
    assistant.dataset.messageAuthorRole = 'assistant';
    assistant.dataset.messageId = '44444444-4444-4444-4444-444444444444';
    assistant.innerHTML = '<img alt="fixture image">';
    document.body.append(assistant);
    fixture.conv.current_node = 'a'; fixture.conv.mapping.u.children = ['a'];
    fixture.conv.mapping.a = { parent: 'u', children: [], message: { id: assistant.dataset.messageId,
      author: { role: 'assistant' }, create_time: Date.now() / 1000, end_turn: true,
      content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'fixture' }] } } };
    paintTurns(fixture.conv); await wait(100);
    check(document.querySelectorAll('.cv-turn-host').length >= 2, 'image-only final response receives end badge');

    await chrome.storage.local.set({ injectionEnabled: false });
    await wait(50);
    check(!__cvTurns.status().loop_active && !document.querySelector('#cv-turn-panel'), 'injection off removes all timing UI');
    check(!__cvSpeed.status().enabled, 'injection off also disables speed');
    await chrome.storage.local.set({ injectionEnabled: true, durations: false });
    history.pushState({}, '', '/dots/55555555-5555-5555-5555-555555555555');
    document.title = 'fixture dot';
    const dock = document.createElement('div');
    dock.innerHTML = '<span class="truncate font-medium">fixture dot</span><span class="contents" aria-hidden="true"></span>';
    document.body.append(dock);
    const control = document.createElement('button');
    control.className = 'group/aeon-status'; control.setAttribute('aria-label', 'Pause fixture dot');
    control.setAttribute('aria-describedby', 'fixture-dot-status');
    control.innerHTML = '<span id="fixture-dot-status">Active 2分钟前</span>';
    document.body.append(control);
    __cvDotsTitle.update();
    check(document.title === '[空闲] fixture dot', 'real DOM empty hidden status means idle');
    const region = dock.querySelector('.contents');
    region.setAttribute('aria-hidden', 'false'); region.setAttribute('role', 'status');
    region.innerHTML = '<span class="line-clamp-2">正在核对部署结果</span>';
    __cvDotsTitle.update();
    check(document.title === '[正在核对部署结果] fixture dot', 'live dots status takes priority');
    region.removeAttribute('role'); region.setAttribute('aria-hidden', 'true'); region.replaceChildren();
    await wait(1100);
    check(document.title === '[空闲] fixture dot', 'observer tracks working to idle transition');
    chrome.runtime.id = undefined;
    await wait(2100);
    check(__cvPage.snapshot().phase === 'reload_required', 'extension invalidation detected');
    check(document.title === 'fixture dot', 'invalidation restores title');
    check(!__cvTurns.status().loop_active && !__cvSpeed.status().enabled, 'invalidation stops timer and speed');
    check(fixture.errors.length === 0, `no page exceptions: ${fixture.errors.join('; ')}`);
    document.querySelector('#result').textContent = JSON.stringify({ ok: true, checks });
  } catch (err) {
    document.querySelector('#result').textContent = JSON.stringify({ ok: false, checks, error: err.stack, pageErrors: fixture.errors });
  }
})();
