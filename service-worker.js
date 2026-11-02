const STORAGE_KEYS = {
  pages: 'savedPages',
  sessions: 'savedSessions'
};

const PAGE_LIMIT = 500;
const CONTEXT_MENU_ID = 'tabrecall-save-page';
const RECALL_URL = 'recall.html';
const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_MAX_HEIGHT = 200;
const THUMBNAIL_DATA_URL_LIMIT = 120000;

let mutationQueue = Promise.resolve();
let menuQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void setupContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (String(info.menuItemId) !== CONTEXT_MENU_ID) {
    return;
  }

  const linkUrl = typeof info.linkUrl === 'string' ? info.linkUrl : '';
  if (linkUrl && !isSavableUrl(linkUrl)) {
    notifySaveResult({ ok: false, message: 'This link cannot be saved.' });
    return;
  }

  const task = isSavableUrl(linkUrl)
    ? () => saveLinkedUrl(linkUrl, info.selectionText)
    : () => {
        if (!tab?.id) {
          return { ok: false, message: 'This page cannot be saved.' };
        }

        return savePageFromTabId(tab.id);
      };

  void enqueueMutation(task)
    .then((result) => {
      notifySaveResult(result);
    })
    .catch((error) => {
      console.error('Unexpected SecondShelf save error:', error);
      notifySaveResult({ ok: false, message: 'Something went wrong. Try again.' });
    });
});

function notifySaveResult(result) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: result.ok ? 'SecondShelf: saved' : 'SecondShelf: save failed',
    message: result.message || 'Something went wrong. Try again.'
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('SecondShelf notification failed:', chrome.runtime.lastError.message);
    }
  });
}

chrome.action.onClicked.addListener(async () => {
  try {
    const existing = await findDashboardTabs();

    if (existing.length > 0) {
      const tab = pickPreferredDashboardTab(existing);
      if (!tab?.id) {
        await createTab({ url: chrome.runtime.getURL(RECALL_URL) });
        return;
      }

      await updateTab(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await updateWindow(tab.windowId, { focused: true });
      }
      return;
    }

    await createTab({ url: chrome.runtime.getURL(RECALL_URL) });
  } catch (error) {
    console.error('Failed to focus recall page:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  void handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error('SecondShelf message handler error:', error);
      sendResponse({ ok: false, message: 'Something went wrong. Try again.' });
    });

  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'SAVE_CURRENT_TAB':
      return enqueueMutation(() => saveMostRecentSavableTab());
    case 'SAVE_ALL_OPEN_TABS':
      return enqueueMutation(() => saveOpenTabsAsSession());
    case 'DELETE_PAGE':
      return enqueueMutation(() => deletePageById(message.pageId));
    case 'DELETE_SESSION':
      return enqueueMutation(() => deleteSessionById(message.sessionId));
    case 'RENAME_PAGE':
      return enqueueMutation(() => renamePageById(message.pageId, message.newTitle));
    case 'RENAME_SESSION':
      return enqueueMutation(() => renameSessionById(message.sessionId, message.newName));
    case 'CLEAR_ALL':
      return enqueueMutation(async () => {
        await storageSet({ [STORAGE_KEYS.pages]: [], [STORAGE_KEYS.sessions]: [] });
        return { ok: true, message: 'Everything was cleared.' };
      });
    default:
      return { ok: false, message: 'Unsupported action.' };
  }
}

function enqueueMutation(task) {
  const result = mutationQueue.then(() => task());
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function setupContextMenus() {
  const run = menuQueue.then(() => createSaveMenu(), () => createSaveMenu());
  menuQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function createSaveMenu() {
  try {
    await removeAllContextMenus();
    await createContextMenu({
      id: CONTEXT_MENU_ID,
      title: 'Save to SecondShelf',
      contexts: ['page', 'selection', 'link']
    });
  } catch (error) {
    console.error('Failed to initialize context menu:', error);
  }
}

async function findDashboardTabs() {
  const recallPageUrl = chrome.runtime.getURL(RECALL_URL);
  const extensionTabs = await queryTabs({ url: recallPageUrl });

  try {
    const newTabs = await queryTabs({ url: 'chrome://newtab/*' });
    return [...extensionTabs, ...newTabs];
  } catch (error) {
    console.debug('New tab lookup unavailable:', error);
    return extensionTabs;
  }
}

function pickPreferredDashboardTab(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return null;
  }

  return [...tabs].sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
}

async function saveMostRecentSavableTab() {
  try {
    const tabs = await queryTabs({ currentWindow: true });
    const activeTab = tabs.find((tab) => tab.active && typeof tab.id === 'number' && isSavableUrl(tab.url));
    if (activeTab?.id) {
      return savePageFromTabId(activeTab.id);
    }

    const candidate = tabs
      .filter((tab) => !tab.active && typeof tab.id === 'number' && isSavableUrl(tab.url))
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];

    if (!candidate?.id) {
      return { ok: false, message: 'No savable tab was found in this window.' };
    }

    const result = await savePageFromTabId(candidate.id);
    if (!result.ok) {
      return result;
    }

    return {
      ...result,
      message: `${result.message} (most recent web tab in this window)`
    };
  } catch (error) {
    console.error('Failed to save most recent tab:', error);
    return { ok: false, message: 'Failed to save the current tab. Try again.' };
  }
}

async function saveOpenTabsAsSession() {
  try {
    const tabs = await queryTabs({ currentWindow: true });
    const items = tabs
      .filter((tab) => isSavableUrl(tab.url))
      .map((tab) => ({
        title: cleanTitle(tab.title),
        url: tab.url
      }));

    if (items.length === 0) {
      return { ok: false, message: 'No regular web pages are open to save.' };
    }

    const storedSessions = await storageGet([STORAGE_KEYS.sessions]);
    const existingSessions = asArray(storedSessions[STORAGE_KEYS.sessions]);
    const session = {
      id: createId('session'),
      name: `Quick session ${new Date().toLocaleString()}`,
      createdAt: new Date().toISOString(),
      count: items.length,
      items
    };

    await storageSet({
      [STORAGE_KEYS.sessions]: [session, ...existingSessions]
    });

    return {
      ok: true,
      message: `Saved ${items.length} open tab${items.length === 1 ? '' : 's'} as a session.`
    };
  } catch (error) {
    console.error('Failed to save open tabs as session:', error);
    return { ok: false, message: 'Failed to save open tabs. Try again.' };
  }
}

async function savePageFromTabId(tabId) {
  try {
    const tab = await getTab(tabId);

    if (!tab || !isSavableUrl(tab.url)) {
      return { ok: false, message: 'This page cannot be saved.' };
    }

    const snippet = await getSnippetFromTab(tabId);
    const thumbnail = await captureVisibleTabThumbnail(tab);

    return persistPage({
      id: createId('page'),
      title: cleanTitle(tab.title),
      url: tab.url,
      domain: getDomain(tab.url),
      snippet,
      thumbnail: thumbnail.value,
      savedAt: new Date().toISOString()
    }, { refreshTitle: Boolean(tab.title?.trim()), thumbnailIsFallback: thumbnail.isFallback });
  } catch (error) {
    console.error('Failed to save page from tab:', error);
    return { ok: false, message: 'Failed to save. Try again.' };
  }
}

async function saveLinkedUrl(url, selectionText) {
  const selected = typeof selectionText === 'string' ? selectionText.replace(/\s+/g, ' ').trim() : '';
  const title = (selected || getDomain(url)).slice(0, 160);

  return persistPage({
    id: createId('page'),
    title,
    url,
    domain: getDomain(url),
    snippet: '',
    thumbnail: '',
    savedAt: new Date().toISOString()
  }, { refreshTitle: false, thumbnailIsFallback: true });
}

async function persistPage(page, { refreshTitle = true, thumbnailIsFallback = false } = {}) {
  try {
    const storedPages = await storageGet([STORAGE_KEYS.pages]);
    const existingPages = asArray(storedPages[STORAGE_KEYS.pages]);
    const existingIndex = existingPages.findIndex((item) => item && item.url === page.url);
    const withinLimit = existingPages.length < PAGE_LIMIT;

    if (existingIndex === -1 && !withinLimit) {
      return {
        ok: false,
        limitReached: true,
        message: `You've reached the free limit of ${PAGE_LIMIT} saves. Consider upgrading for unlimited storage and pro features (coming soon).`
      };
    }

    let updatedPages;
    let actionLabel = 'Saved';

    if (existingIndex >= 0) {
      const existingPage = existingPages[existingIndex];
      const refreshedPage = {
        ...existingPage,
        title: (refreshTitle && page.title) || existingPage.title || page.title,
        domain: page.domain || existingPage.domain,
        snippet: page.snippet || existingPage.snippet,
        thumbnail: (thumbnailIsFallback && existingPage.thumbnail) || page.thumbnail || existingPage.thumbnail,
        savedAt: page.savedAt
      };

      updatedPages = [
        refreshedPage,
        ...existingPages.slice(0, existingIndex),
        ...existingPages.slice(existingIndex + 1)
      ];
      actionLabel = 'Updated';
    } else {
      updatedPages = [page, ...existingPages];
    }

    await storageSet({ [STORAGE_KEYS.pages]: updatedPages });

    return {
      ok: true,
      message: `${actionLabel}: ${updatedPages[0].title}`,
      limitReached: false
    };
  } catch (error) {
    console.error('Failed to save page from tab:', error);
    return { ok: false, message: 'Failed to save. Try again.' };
  }
}

async function deletePageById(pageId) {
  if (!pageId) {
    return { ok: false, message: 'That saved page could not be found.' };
  }

  try {
    const storedPages = await storageGet([STORAGE_KEYS.pages]);
    const existingPages = asArray(storedPages[STORAGE_KEYS.pages]);
    const updatedPages = existingPages.filter((page) => page && page.id !== pageId);

    if (updatedPages.length === existingPages.length) {
      return { ok: false, message: 'That saved page no longer exists.' };
    }

    await storageSet({ [STORAGE_KEYS.pages]: updatedPages });
    return { ok: true, message: 'Saved page deleted.' };
  } catch (error) {
    console.error('Failed to delete saved page:', error);
    return { ok: false, message: 'Failed to delete that saved page. Try again.' };
  }
}

async function deleteSessionById(sessionId) {
  if (!sessionId) {
    return { ok: false, message: 'That session group could not be found.' };
  }

  try {
    const storedSessions = await storageGet([STORAGE_KEYS.sessions]);
    const existingSessions = asArray(storedSessions[STORAGE_KEYS.sessions]);
    const updatedSessions = existingSessions.filter((session) => session && session.id !== sessionId);

    if (updatedSessions.length === existingSessions.length) {
      return { ok: false, message: 'That session group no longer exists.' };
    }

    await storageSet({ [STORAGE_KEYS.sessions]: updatedSessions });
    return { ok: true, message: 'Session group deleted.' };
  } catch (error) {
    console.error('Failed to delete saved session:', error);
    return { ok: false, message: 'Failed to delete that session group. Try again.' };
  }
}

async function renamePageById(pageId, newTitle) {
  if (!pageId) {
    return { ok: false, message: 'Saved page not specified.' };
  }

  const trimmedTitle = String(newTitle || '').trim().slice(0, 160);
  if (!trimmedTitle) {
    return { ok: false, message: 'Page title cannot be empty.' };
  }

  try {
    const storedPages = await storageGet([STORAGE_KEYS.pages]);
    const existingPages = asArray(storedPages[STORAGE_KEYS.pages]);
    const index = existingPages.findIndex((page) => page && page.id === pageId);
    if (index === -1) {
      return { ok: false, message: 'That saved page no longer exists.' };
    }

    const updated = [...existingPages];
    updated[index] = { ...updated[index], title: trimmedTitle };
    await storageSet({ [STORAGE_KEYS.pages]: updated });
    return { ok: true, message: 'Saved page renamed.' };
  } catch (error) {
    console.error('Failed to rename saved page:', error);
    return { ok: false, message: 'Failed to rename saved page. Try again.' };
  }
}

async function renameSessionById(sessionId, newName) {
  if (!sessionId) {
    return { ok: false, message: 'Session not specified.' };
  }

  const trimmedName = String(newName || '').trim().slice(0, 120);
  if (!trimmedName) {
    return { ok: false, message: 'Session name cannot be empty.' };
  }

  try {
    const storedSessions = await storageGet([STORAGE_KEYS.sessions]);
    const existingSessions = asArray(storedSessions[STORAGE_KEYS.sessions]);
    const index = existingSessions.findIndex((session) => session && session.id === sessionId);
    if (index === -1) {
      return { ok: false, message: 'Session not found.' };
    }

    const updated = [...existingSessions];
    updated[index] = { ...updated[index], name: trimmedName };

    await storageSet({ [STORAGE_KEYS.sessions]: updated });
    return { ok: true, message: 'Session renamed.' };
  } catch (error) {
    console.error('Failed to rename session:', error);
    return { ok: false, message: 'Failed to rename session. Try again.' };
  }
}

async function getSnippetFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
    const response = await sendMessageToTab(tabId, { type: 'GET_PAGE_SNIPPET' });
    if (response?.snippet) {
      return response.snippet;
    }
  } catch (error) {
    console.debug('Snippet extraction unavailable for tab', tabId, error);
  }

  return '';
}

async function captureVisibleTabThumbnail(tab) {
  const fallback = tab?.favIconUrl || '';
  if (typeof tab?.windowId !== 'number' || tab.active !== true) {
    return { value: fallback, isFallback: true };
  }

  try {
    const dataUrl = await captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 40
    });

    if (!dataUrl) {
      return { value: fallback, isFallback: true };
    }

    const value = await resizeThumbnailDataUrl(dataUrl, fallback);
    return { value, isFallback: value === fallback };
  } catch (error) {
    console.debug('Thumbnail capture unavailable for tab', tab.id, error);
    return { value: fallback, isFallback: true };
  }
}

async function resizeThumbnailDataUrl(dataUrl, fallback) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(
      THUMBNAIL_MAX_WIDTH / bitmap.width,
      THUMBNAIL_MAX_HEIGHT / bitmap.height,
      1
    );
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d', { alpha: false });

    if (!context) {
      bitmap.close();
      return fallback;
    }

    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    const resizedUrl = await blobToDataUrl(resizedBlob);
    if (resizedUrl.length > THUMBNAIL_DATA_URL_LIMIT) {
      return fallback;
    }

    return resizedUrl;
  } catch (error) {
    console.debug('Thumbnail resize failed, skipping the full capture.', error);
    return fallback;
  }
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x4000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }

  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

function isSavableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'Unknown source';
  }
}

function cleanTitle(title) {
  const value = typeof title === 'string' ? title.trim() : '';
  return value || 'Untitled page';
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tabs);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function createTab(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function captureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function updateTab(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, updateProperties, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
}

function updateWindow(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    chrome.windows.update(windowId, updateInfo, (window) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(window);
    });
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function removeAllContextMenus() {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function createContextMenu(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.create(createProperties, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}
