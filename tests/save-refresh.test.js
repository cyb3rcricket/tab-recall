const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function worker(initialPages = []) {
  const storage = { savedPages: initialPages };
  let tab;
  const listener = { addListener() {} };
  const chrome = {
    runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
    contextMenus: { onClicked: listener },
    action: { onClicked: listener },
    scripting: { async executeScript() {} },
    storage: { local: {
      get(_keys, callback) { callback(storage); },
      set(items, callback) { Object.assign(storage, items); callback(); }
    } },
    tabs: {
      get(_id, callback) { callback(tab); },
      sendMessage(_id, _message, callback) { callback({ snippet: tab.snippet || '' }); },
      captureVisibleTab(_windowId, _options, callback) { callback('capture'); }
    }
  };
  const context = vm.createContext({ chrome, URL, console });
  vm.runInContext(fs.readFileSync(require.resolve('../service-worker.js'), 'utf8'), context);
  return { context, storage, setTab(value) { tab = value; } };
}

const original = () => ({
  id: 'original', url: 'https://example.com/article', domain: 'example.com',
  title: 'Real article title', snippet: 'Original snippet', thumbnail: 'data:old-screenshot',
  savedAt: '2020-01-01T00:00:00.000Z'
});

test('link re-save preserves existing title and preview, and moves the entry to the top', async () => {
  const w = worker([{ id: 'other', url: 'https://other.example' }, original()]);
  const result = await w.context.saveLinkedUrl('https://example.com/article', 'Selected link text');
  const page = w.storage.savedPages[0];
  assert.equal(result.message, 'Updated: Real article title');
  assert.equal(w.storage.savedPages.length, 2);
  assert.equal(page.id, 'original');
  assert.equal(page.title, 'Real article title');
  assert.equal(page.snippet, 'Original snippet');
  assert.equal(page.thumbnail, 'data:old-screenshot');
  assert.notEqual(page.savedAt, '2020-01-01T00:00:00.000Z');
});

test('link re-save without selected text does not replace the title with the domain', async () => {
  const w = worker([original()]);
  await w.context.saveLinkedUrl(original().url);
  assert.equal(w.storage.savedPages[0].title, 'Real article title');
  assert.equal(w.storage.savedPages[0].thumbnail, 'data:old-screenshot');
});

test('background tab re-save keeps the screenshot even when a favicon is available', async () => {
  const w = worker([original()]);
  w.setTab({ id: 1, windowId: 1, active: false, url: original().url, title: 'Updated title', favIconUrl: 'https://example.com/favicon.ico' });
  assert.equal((await w.context.savePageFromTabId(1)).ok, true);
  assert.equal(w.storage.savedPages[0].title, 'Updated title');
  assert.equal(w.storage.savedPages[0].thumbnail, 'data:old-screenshot');
  assert.equal(w.storage.savedPages[0].snippet, 'Original snippet');
});

test('successful active tab capture refreshes metadata', async () => {
  const w = worker([original()]);
  w.setTab({ id: 1, windowId: 1, active: true, url: original().url, title: 'New title', snippet: 'New snippet' });
  vm.runInContext("resizeThumbnailDataUrl = async () => 'data:new-screenshot'", w.context);
  await w.context.savePageFromTabId(1);
  assert.equal(w.storage.savedPages[0].title, 'New title');
  assert.equal(w.storage.savedPages[0].snippet, 'New snippet');
  assert.equal(w.storage.savedPages[0].thumbnail, 'data:new-screenshot');
});

test('new link and background tab saves retain their available fallback metadata', async () => {
  const w = worker();
  await w.context.saveLinkedUrl('https://example.com/article', 'Selected text');
  assert.equal(w.storage.savedPages[0].title, 'Selected text');
  w.setTab({ id: 1, windowId: 1, active: false, url: 'https://other.example/', title: 'Other', favIconUrl: 'favicon' });
  await w.context.savePageFromTabId(1);
  assert.equal(w.storage.savedPages[0].thumbnail, 'favicon');
});

test('missing tab title and unavailable thumbnail do not erase existing metadata', async () => {
  const w = worker([original()]);
  w.setTab({ id: 1, windowId: 1, active: false, url: original().url, title: '' });
  await w.context.savePageFromTabId(1);
  assert.equal(w.storage.savedPages[0].title, 'Real article title');
  assert.equal(w.storage.savedPages[0].thumbnail, 'data:old-screenshot');
});
