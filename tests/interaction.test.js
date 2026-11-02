const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker() {
  const listeners = {};
  const events = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const notifications = [];
  const queries = [];
  const chrome = {
    runtime: { onInstalled: events('installed'), onStartup: events('startup'), onMessage: events('message'), getURL: (path) => `chrome-extension://test/${path}` },
    contextMenus: { onClicked: events('context') },
    action: { onClicked: events('action') },
    notifications: { create(options, callback) { notifications.push(options); callback(); } },
    tabs: { query(query, callback) { queries.push(query); callback(query.url.startsWith('chrome-extension') ? [{ id: 3, windowId: 2 }] : []); } }
  };
  const context = vm.createContext({ chrome, console, URL });
  vm.runInContext(fs.readFileSync(require.resolve('../service-worker.js'), 'utf8'), context);
  return { context, listeners, notifications, queries };
}

test('right-click success and failures produce notifications', async () => {
  const w = worker();
  w.listeners.context({ menuItemId: 'tabrecall-save-page', linkUrl: 'javascript:alert(1)' }, {});
  assert.match(w.notifications[0].title, /failed/);
  vm.runInContext("saveLinkedUrl = async () => ({ ok: true, message: 'Saved: Example' })", w.context);
  w.listeners.context({ menuItemId: 'tabrecall-save-page', linkUrl: 'https://example.com' }, {});
  await vm.runInContext('mutationQueue', w.context);
  await new Promise(setImmediate);
  assert.equal(w.notifications[1].message, 'Saved: Example');
  vm.runInContext("saveLinkedUrl = async () => ({ ok: false, message: 'Storage full' })", w.context);
  w.listeners.context({ menuItemId: 'tabrecall-save-page', linkUrl: 'https://example.com' }, {});
  await vm.runInContext('mutationQueue', w.context);
  await new Promise(setImmediate);
  assert.equal(w.notifications[2].message, 'Storage full');
});

test('toolbar searches all windows for a dashboard', async () => {
  const w = worker();
  const found = await w.context.findDashboardTabs();
  assert.equal(found[0].windowId, 2);
  assert.equal(w.queries.length, 2);
  assert.ok(w.queries.every((query) => !('currentWindow' in query)));
});

test('simultaneous restores of one session open its tabs only once', async () => {
  const document = { documentElement: { getAttribute() { return null; } }, getElementById() { return {}; }, addEventListener() {} };
  const context = vm.createContext({ document, console, window: { confirm: () => true } });
  vm.runInContext(fs.readFileSync(require.resolve('../recall.js'), 'utf8'), context);
  let finish;
  let opened = 0;
  context.open = () => { opened++; return new Promise((resolve) => { finish = resolve; }); };
  vm.runInContext('createTab = open; showStatus = () => {}', context);
  const session = { id: 'one', items: [{ url: 'https://example.com' }] };
  const first = context.restoreSession(session);
  await context.restoreSession(session);
  assert.equal(opened, 1);
  finish();
  await first;
  const again = context.restoreSession(session);
  assert.equal(opened, 2);
  finish();
  await again;
});

test('theme cache is applied synchronously and extension storage remains authoritative', () => {
  const attrs = {};
  let callback;
  const cache = { theme: 'day' };
  const context = vm.createContext({
    document: { documentElement: { setAttribute(name, value) { attrs[name] = value; } } },
    localStorage: { getItem(key) { return cache[key]; }, setItem(key, value) { cache[key] = value; } },
    chrome: { storage: { local: { get(_keys, done) { callback = done; } } } }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../theme-init.js'), 'utf8'), context);
  assert.equal(attrs['data-theme'], 'day');
  callback({ theme: 'night' });
  assert.equal(attrs['data-theme'], 'night');
  assert.equal(cache.theme, 'night');
});

test('repeated on-demand snippet injection installs only one listener', () => {
  let count = 0;
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener() { count++; } } } } });
  const source = fs.readFileSync(require.resolve('../content-script.js'), 'utf8');
  vm.runInContext(source, context);
  vm.runInContext(source, context);
  assert.equal(count, 1);
});
