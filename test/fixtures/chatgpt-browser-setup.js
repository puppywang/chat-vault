// Synthetic Chrome APIs and API responses, real browser DOM/ShadowDOM/observers.
// This fixture has no access to the user's profile, tokens or ChatVault database.
window.fixture = { settings: { auto: false, syncEnabled: false, injectionEnabled: true,
  durations: true, speedMetrics: true, dotsTitle: true, diagnostics: false }, errors: [], writes: [], listeners: [] };
window.addEventListener('error', e => fixture.errors.push(e.message));
window.addEventListener('unhandledrejection', e => fixture.errors.push(String(e.reason)));
window.chrome = {
  runtime: { id: 'fixture', getManifest: () => ({ version:'fixture' }), onMessage: { addListener() {} }, async sendMessage(message) {
    fixture.writes.push(message);
    return { ok: true, tokens: 42 };
  } },
  storage: { local: {
    async get(defaults) {
      if (Array.isArray(defaults)) return Object.fromEntries(defaults.map(key => [key, fixture.settings[key]]));
      return { ...defaults, ...fixture.settings };
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue, oldValue: fixture.settings[key] }]));
      Object.assign(fixture.settings, values);
      for (const listener of fixture.listeners) listener(changes, 'local');
    },
  }, onChanged: { addListener(fn) { fixture.listeners.push(fn); } } },
};
fixture.id = location.pathname.split('/').at(-1);
fixture.userId = '33333333-3333-3333-3333-333333333333';
fixture.staged = new URLSearchParams(location.search).has('staged');
fixture.conv = { conversation_id: fixture.id, current_node: 'u', mapping: {
  u: { parent: null, children: [], message: { id: fixture.userId, author: { role: 'user' },
    create_time: Date.now() / 1000 - 60, content: { parts: ['fixture question'] } } },
} };
window.fetch = async url => {
  if (url === '/api/auth/session') return new Response(JSON.stringify({ accessToken: 'fixture-only' }));
  if (url === `/backend-api/conversation/${fixture.id}`) return new Response(JSON.stringify(fixture.conv), {headers:{'Content-Type':'application/json'}});
  throw new Error(`Unexpected fixture request: ${url}`);
};
document.title = 'fixture';
const question = document.createElement('div');
question.setAttribute('data-message-author-role', 'user');
question.setAttribute('data-message-id', fixture.staged ? '66666666-6666-6666-6666-666666666666' : fixture.userId);
question.textContent = 'fixture question';
document.body.append(question);
const stop = document.createElement('button');
stop.setAttribute('data-testid', 'stop-button');
stop.textContent = 'Stop';
if (!fixture.staged) document.body.append(stop);
else setTimeout(() => {
  const current = question.cloneNode(true);
  current.setAttribute('data-message-id', fixture.userId);
  document.body.append(current, stop);
}, 180);
