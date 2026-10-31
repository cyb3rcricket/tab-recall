const STORAGE_KEYS = {
  pages: 'savedPages',
  sessions: 'savedSessions'
};

const PAGE_LIMIT = 500;
const CONTEXT_MENU_ID = 'tabrecall-save-page';
const CONTEXT_MENU_IDS = ['tabrecall-save-page', 'secondshelf-save-page'];
const RECALL_URL = 'recall.html';
const THUMBNAIL_MAX_WIDTH = 320;
const THUMBNAIL_MAX_HEIGHT = 200;

void setupContextMenus();

chrome.runtime.onInstalled.addListener(() => {
  void setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void setupContextMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!CONTEXT_MENU_IDS.includes(String(info.menuItemId)) || !tab?.id) {
    return;
  }

  void savePageFromTabId(tab.id)
    .then((result) => {
      if (!result.ok) {
        console.warn('SecondShelf save failed:', result.message);
      }
    })
    .catch((error) => {
      console.error('Unexpected SecondShelf save error:', error);
    });
});

chrome.action.onClicked.addListener(async () => {
  try {
    const recallPageUrl = chrome.runtime.getURL(RECALL_URL);
    const existing = await queryTabs({ url: recallPageUrl });

    if (existing.length > 0) {
      const [tab] = existing;
      await updateTab(tab.id, { active: true });
      if (typeof tab.windowId === 'number') {
        await updateWindow(tab.windowId, { focused: true });
      }
      return;
    }

    await createTab({ url: recallPageUrl });
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
      return saveMostRecentSavableTab();
    case 'SAVE_ALL_OPEN_TABS':
      return saveOpenTabsAsSession();
    case 'DELETE_PAGE':
      return deletePageById(message.pageId);
    case 'DELETE_SESSION':
      return deleteSessionById(message.sessionId);
    case 'RENAME_SESSION':
      return renameSessionById(message.sessionId, message.newName);
    case 'CLEAR_ALL':
      await storageSet({ [STORAGE_KEYS.pages]: [], [STORAGE_KEYS.sessions]: [] });
      return { ok: true, message: 'Everything was cleared.' };
    default:
      return { ok: false, message: 'Unsupported action.' };
  }
}

async function setupContextMenus() {
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

async function saveMostRecentSavableTab() {
  try {
    const tabs = await queryTabs({ currentWindow: true });
    const candidate = tabs
      .filter((tab) => typeof tab.id === 'number' && isSavableUrl(tab.url))
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];

    if (!candidate?.id) {
      return { ok: false, message: 'No savable tab was found in this window.' };
    }

    return savePageFromTabId(candidate.id);
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

    const { [STORAGE_KEYS.sessions]: existingSessions = [] } = await storageGet([STORAGE_KEYS.sessions]);
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

    // Capture page text and a lightweight visible-area preview in parallel.
    const [snippet, thumbnail] = await Promise.all([
      getSnippetFromTab(tabId),
      captureVisibleTabThumbnail(tab)
    ]);

    const page = {
      id: createId('page'),
      title: cleanTitle(tab.title),
      url: tab.url,
      domain: getDomain(tab.url),
      snippet,
      thumbnail,
      savedAt: new Date().toISOString()
    };

    const { [STORAGE_KEYS.pages]: existingPages = [] } = await storageGet([STORAGE_KEYS.pages]);
    const existingIndex = existingPages.findIndex((item) => item.url === page.url);
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
        title: page.title || existingPage.title,
        domain: page.domain || existingPage.domain,
        snippet: page.snippet || existingPage.snippet,
        thumbnail: page.thumbnail || existingPage.thumbnail || '',
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
      message: `${actionLabel}: ${page.title}`,
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
    const { [STORAGE_KEYS.pages]: existingPages = [] } = await storageGet([STORAGE_KEYS.pages]);
    const updatedPages = existingPages.filter((page) => page.id !== pageId);

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
    const { [STORAGE_KEYS.sessions]: existingSessions = [] } = await storageGet([STORAGE_KEYS.sessions]);
    const updatedSessions = existingSessions.filter((session) => session.id !== sessionId);

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

async function renameSessionById(sessionId, newName) {
  if (!sessionId) {
    return { ok: false, message: 'Session not specified.' };
  }

  const trimmedName = String(newName || '').trim();
  if (!trimmedName) {
    return { ok: false, message: 'Session name cannot be empty.' };
  }

  try {
    const { [STORAGE_KEYS.sessions]: existingSessions = [] } = await storageGet([STORAGE_KEYS.sessions]);
    const idx = existingSessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      return { ok: false, message: 'Session not found.' };
    }

    const updated = [...existingSessions];
    updated[idx] = { ...updated[idx], name: trimmedName };

    await storageSet({ [STORAGE_KEYS.sessions]: updated });
    return { ok: true, message: 'Session renamed.' };
  } catch (error) {
    console.error('Failed to rename session:', error);
    return { ok: false, message: 'Failed to rename session. Try again.' };
  }
}

async function getSnippetFromTab(tabId) {
  try {
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
  if (typeof tab?.windowId !== 'number' || typeof tab.id !== 'number') {
    return '';
  }

  const activeTabs = await queryTabs({ active: true, windowId: tab.windowId });
  const currentActiveTab = activeTabs[0];
  const shouldRestoreActiveTab = typeof currentActiveTab?.id === 'number' && currentActiveTab.id !== tab.id;

  try {
    await updateWindow(tab.windowId, { focused: true });

    if (shouldRestoreActiveTab) {
      await updateTab(tab.id, { active: true });
    }

    await waitForTabSettled(tab.id, 1200);
    await delay(250);

    // Visible-area capture is enough for a quick library preview and keeps this flow fast.
    const dataUrl = await captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 40
    });

    if (!dataUrl) {
      return tab.favIconUrl || '';
    }

    return await resizeThumbnailDataUrl(dataUrl);
  } catch (error) {
    console.debug('Thumbnail capture unavailable for tab', tab.id, error);
    return tab.favIconUrl || '';
  } finally {
    if (shouldRestoreActiveTab) {
      try {
        await updateTab(currentActiveTab.id, { active: true });
      } catch (restoreError) {
        console.debug('Failed to restore previously active tab after thumbnail capture.', restoreError);
      }
    }
  }
}

async function resizeThumbnailDataUrl(dataUrl) {
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
      return dataUrl;
    }

    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    return await blobToDataUrl(resizedBlob);
  } catch (error) {
    console.debug('Thumbnail resize failed, using original capture.', error);
    return dataUrl;
  }
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `data:${blob.type};base64,${btoa(binary)}`;
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

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function waitForTabSettled(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      clearTimeout(timeoutId);
      resolve();
    };

    const handleUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        finish();
      }
    };

    const timeoutId = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(handleUpdated);

    void getTab(tabId)
      .then((tab) => {
        if (tab?.status === 'complete') {
          finish();
        }
      })
      .catch(() => {
        finish();
      });
  });
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