const STORAGE_KEYS = {
  pages: 'savedPages',
  sessions: 'savedSessions',
  theme: 'theme'
};

const PAGE_LIMIT = 500;
const SEARCH_DEBOUNCE_MS = 300;

const state = {
  pages: [],
  sessions: [],
  filteredPages: [],
  query: '',
  theme: document.documentElement.getAttribute('data-theme') || 'night',
  loading: true,
  renamingPageId: null,
  renamingPageValue: '',
  renamingPagePendingId: null,
  renamingSessionId: null,
  renamingSessionValue: '',
  renamingSessionPendingId: null
};

const elements = {
  searchInput: document.getElementById('search-input'),
  searchStatus: document.getElementById('search-status'),
  storageSummary: document.getElementById('storage-summary'),
  upgradeLinkInline: document.getElementById('upgrade-link-inline'),
  limitBanner: document.getElementById('limit-banner'),
  limitMessage: document.getElementById('limit-message'),
  statusBanner: document.getElementById('status-banner'),
  pagesCount: document.getElementById('pages-count'),
  sessionsCount: document.getElementById('sessions-count'),
  loadingState: document.getElementById('loading-state'),
  emptyState: document.getElementById('empty-state'),
  sessionsEmptyState: document.getElementById('sessions-empty-state'),
  savedPagesList: document.getElementById('saved-pages-list'),
  sessionGroupsList: document.getElementById('session-groups-list'),
  saveCurrentButton: document.getElementById('save-current-button'),
  saveSessionButton: document.getElementById('save-session-button'),
  clearAllButton: document.getElementById('clear-all-button'),
  themeToggleInput: document.getElementById('theme-toggle-input')
};

document.addEventListener('DOMContentLoaded', () => {
  void initializeTheme();
  bindEvents();
  void loadLibrary();
});

function bindEvents() {
  elements.themeToggleInput.addEventListener('change', async (event) => {
    const nextTheme = event.target.checked ? 'day' : 'night';
    await setTheme(nextTheme);
  });

  elements.searchInput.addEventListener(
    'input',
    debounce((event) => {
      state.query = event.target.value.trim();
      applySearch();
      render();
    }, SEARCH_DEBOUNCE_MS)
  );

  elements.saveCurrentButton.addEventListener('click', async () => {
    await performBackgroundAction({ type: 'SAVE_CURRENT_TAB' });
  });

  elements.saveSessionButton.addEventListener('click', async () => {
    await performBackgroundAction({ type: 'SAVE_ALL_OPEN_TABS' });
  });

  elements.clearAllButton.addEventListener('click', async () => {
    const confirmed = window.confirm('Clear all saved pages and session groups?');
    if (!confirmed) {
      return;
    }

    await performBackgroundAction({ type: 'CLEAR_ALL' });
  });
}

async function initializeTheme() {
  const theme = await getStoredThemePreference();
  applyTheme(theme);
}

async function setTheme(theme) {
  applyTheme(theme);

  try {
    await storageSet({ [STORAGE_KEYS.theme]: state.theme });
  } catch (error) {
    console.error('Failed to save theme preference:', error);
  }
}

async function getStoredThemePreference() {
  try {
    const { [STORAGE_KEYS.theme]: storedTheme = 'night' } = await storageGet([STORAGE_KEYS.theme]);
    return storedTheme === 'day' ? 'day' : 'night';
  } catch (error) {
    console.error('Failed to load theme preference:', error);
    return 'night';
  }
}

function applyTheme(theme) {
  state.theme = theme === 'day' ? 'day' : 'night';
  document.documentElement.setAttribute('data-theme', state.theme);
  syncThemeToggle();
}

function syncThemeToggle() {
  if (!elements.themeToggleInput) {
    return;
  }

  const isDay = state.theme === 'day';
  elements.themeToggleInput.checked = isDay;
  elements.themeToggleInput.setAttribute('aria-checked', String(isDay));
}

async function deletePage(pageId) {
  const confirmed = window.confirm('Delete this saved page? This cannot be undone.');
  if (!confirmed) {
    return;
  }

  await performBackgroundAction({ type: 'DELETE_PAGE', pageId });
}

function beginPageRename(page) {
  state.renamingPageId = page.id;
  state.renamingPageValue = page.title || 'Untitled page';
  render();

  window.requestAnimationFrame(() => {
    const input = document.querySelector(`[data-page-rename-input="${page.id}"]`);
    if (!input) {
      return;
    }

    input.focus();
    input.select();
  });
}

function cancelPageRename() {
  state.renamingPageId = null;
  state.renamingPageValue = '';
  state.renamingPagePendingId = null;
  render();
}

async function commitPageRename(page) {
  if (state.renamingPagePendingId === page.id) {
    return;
  }

  const nextTitle = String(state.renamingPageValue || '').trim();
  const currentTitle = page.title || 'Untitled page';

  if (!nextTitle) {
    showStatus('Page title cannot be empty.', true);
    return;
  }

  if (nextTitle === currentTitle) {
    cancelPageRename();
    return;
  }

  state.renamingPagePendingId = page.id;
  state.renamingPageId = null;
  state.renamingPageValue = '';
  render();

  try {
    await renamePageLocally(page.id, nextTitle);
    showStatus('Saved page renamed.', false);
    await loadLibrary();
  } catch (error) {
    console.error('Failed to rename saved page:', error);
    showStatus('Failed to rename saved page. Try again.', true);
  } finally {
    state.renamingPagePendingId = null;
  }
}

async function renamePageLocally(pageId, newTitle) {
  const { [STORAGE_KEYS.pages]: existingPages = [] } = await storageGet([STORAGE_KEYS.pages]);
  const nextPages = existingPages.map((page) => {
    if (page.id !== pageId) {
      return page;
    }

    return {
      ...page,
      title: newTitle
    };
  });

  const didChange = nextPages.some((page, index) => page !== existingPages[index]);
  if (!didChange) {
    throw new Error('Saved page not found');
  }

  await storageSet({ [STORAGE_KEYS.pages]: nextPages });
}

async function deleteSession(sessionId) {
  const confirmed = window.confirm('Delete this saved session group? This cannot be undone.');
  if (!confirmed) {
    return;
  }

  await performBackgroundAction({ type: 'DELETE_SESSION', sessionId });
}

function beginSessionRename(session) {
  state.renamingSessionId = session.id;
  state.renamingSessionValue = session.name || 'Quick session';
  render();

  window.requestAnimationFrame(() => {
    const input = document.querySelector(`[data-session-rename-input="${session.id}"]`);
    if (!input) {
      return;
    }

    input.focus();
    input.select();
  });
}

function cancelSessionRename() {
  state.renamingSessionId = null;
  state.renamingSessionValue = '';
  state.renamingSessionPendingId = null;
  render();
}

async function commitSessionRename(session) {
  if (state.renamingSessionPendingId === session.id) {
    return;
  }

  const nextName = String(state.renamingSessionValue || '').trim();
  const currentName = session.name || 'Quick session';

  if (!nextName) {
    showStatus('Session name cannot be empty.', true);
    return;
  }

  if (nextName === currentName) {
    cancelSessionRename();
    return;
  }

  state.renamingSessionPendingId = session.id;
  state.renamingSessionId = null;
  state.renamingSessionValue = '';
  render();

  try {
    await renameSessionLocally(session.id, nextName);
    showStatus('Session renamed.', false);
    await loadLibrary();
  } catch (error) {
    console.error('Failed to rename session:', error);
    showStatus('Failed to rename session. Try again.', true);
  } finally {
    state.renamingSessionPendingId = null;
  }
}

async function renameSessionLocally(sessionId, newName) {
  const { [STORAGE_KEYS.sessions]: existingSessions = [] } = await storageGet([STORAGE_KEYS.sessions]);
  const nextSessions = existingSessions.map((session) => {
    if (session.id !== sessionId) {
      return session;
    }

    return {
      ...session,
      name: newName
    };
  });

  const didChange = nextSessions.some((session, index) => session !== existingSessions[index]);
  if (!didChange) {
    throw new Error('Session not found');
  }

  await storageSet({ [STORAGE_KEYS.sessions]: nextSessions });
}

async function loadLibrary() {
  setLoading(true);

  try {
    const { [STORAGE_KEYS.pages]: pages = [], [STORAGE_KEYS.sessions]: sessions = [] } = await storageGet([
      STORAGE_KEYS.pages,
      STORAGE_KEYS.sessions
    ]);

    state.pages = Array.isArray(pages) ? pages : [];
    state.sessions = Array.isArray(sessions) ? sessions : [];
    applySearch();
  } catch (error) {
    console.error('Failed to load SecondShelf library:', error);
    showStatus('Failed to load your saved pages. Try reloading this tab.', true);
  } finally {
    setLoading(false);
    render();
  }
}

async function performBackgroundAction(message) {
  toggleBusyButtons(true);

  try {
    const result = await sendRuntimeMessage(message);

    if (!result?.ok) {
      if (result?.limitReached) {
        showLimitBanner(result.message);
      }
      showStatus(result?.message || 'Action failed. Try again.', true);
      return;
    }

    showStatus(result.message || 'Done.', false);
    await loadLibrary();
  } catch (error) {
    console.error('Background action failed:', error);
    showStatus('Failed to complete the action. Try again.', true);
  } finally {
    toggleBusyButtons(false);
  }
}

function applySearch() {
  if (!state.query) {
    state.filteredPages = [...state.pages];
    return;
  }

  const query = normalize(state.query);
  const scored = state.pages
    .map((page) => ({
      page,
      score: scorePage(query, page)
    }))
    .filter((entry) => entry.score >= 0.4)
    .sort((left, right) => right.score - left.score);

  state.filteredPages = scored.map((entry) => entry.page);
}

function scorePage(query, page) {
  const fields = [page.title, page.url, page.snippet, page.domain]
    .filter(Boolean)
    .map((value) => normalize(value));
  const combined = fields.join(' ');

  if (!combined) {
    return 0;
  }

  if (combined.includes(query)) {
    return 1;
  }

  const queryTokens = query.split(' ').filter(Boolean);
  const fieldWords = combined.split(/[^a-z0-9]+/).filter(Boolean).slice(0, 160);

  if (queryTokens.length === 0 || fieldWords.length === 0) {
    return 0;
  }

  let total = 0;

  for (const token of queryTokens) {
    let best = 0;

    for (const word of fieldWords) {
      if (word === token) {
        best = 1;
        break;
      }

      if (word.includes(token) || token.includes(word)) {
        best = Math.max(best, 0.92);
        continue;
      }

      const subsequence = subsequenceSimilarity(token, word);
      const editSimilarity = normalizedEditSimilarity(token, word);
      best = Math.max(best, subsequence, editSimilarity);
    }

    total += best;
  }

  return total / queryTokens.length;
}

function render() {
  const pageCount = state.pages.length;
  const sessionCount = state.sessions.length;

  elements.pagesCount.textContent = String(pageCount);
  elements.sessionsCount.textContent = String(sessionCount);
  elements.searchStatus.textContent = `${state.filteredPages.length} result${state.filteredPages.length === 1 ? '' : 's'}`;
  elements.storageSummary.textContent = `${pageCount}/${PAGE_LIMIT} page saves used • ${sessionCount} session group${sessionCount === 1 ? '' : 's'}`;

  toggleVisibility(elements.upgradeLinkInline, pageCount >= PAGE_LIMIT);
  if (pageCount >= PAGE_LIMIT) {
    showLimitBanner(`You've reached the free limit of ${PAGE_LIMIT} saves. Consider upgrading for unlimited storage and pro features (coming soon).`);
  } else {
    hideLimitBanner();
  }

  renderPages();
  renderSessions();
}

function renderPages() {
  elements.savedPagesList.innerHTML = '';

  if (state.loading) {
    toggleVisibility(elements.loadingState, true);
    toggleVisibility(elements.emptyState, false);
    return;
  }

  toggleVisibility(elements.loadingState, false);

  if (state.filteredPages.length === 0) {
    const hasAnyPages = state.pages.length > 0;
    toggleVisibility(elements.emptyState, !hasAnyPages || Boolean(state.query));

    if (hasAnyPages && state.query) {
      elements.emptyState.innerHTML = '<h3>No matches found</h3><p>Try a shorter search term or a different typo-friendly variation.</p>';
    } else {
      elements.emptyState.innerHTML = '<h3>Nothing saved yet</h3><p>Right-click any page and choose Save to SecondShelf, or use the buttons above to start building your recall shelf.</p>';
    }
    return;
  }

  toggleVisibility(elements.emptyState, false);

  const fragment = document.createDocumentFragment();

  for (const page of state.filteredPages) {
    const card = document.createElement('article');
    card.className = 'saved-card';
    const isRenaming = state.renamingPageId === page.id;
    card.tabIndex = isRenaming ? -1 : 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Open ${page.title}`);
    card.addEventListener('click', () => {
      if (isRenaming) {
        return;
      }

      openPage(page.url);
    });
    card.addEventListener('keydown', (event) => {
      if (isRenaming) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openPage(page.url);
      }
    });

    const thumbnailMarkup = page.thumbnail
      ? `<img src="${escapeAttribute(page.thumbnail)}" alt="Page preview" class="card-thumbnail" />`
      : '';

    card.innerHTML = `
      <div class="card-top-row">
        <span class="domain-pill">${escapeHtml(page.domain || getDomain(page.url))}</span>
        <div class="card-actions">
          <time class="saved-time">${formatDateTime(page.savedAt)}</time>
          <div class="action-button-stack">
            <button class="delete-button" type="button" aria-label="Delete saved page">
              <img src="icons/trash.svg" class="delete-icon" alt="" />
              <span>Delete</span>
            </button>
            <button class="icon-button rename-button" type="button" aria-label="Rename saved page">
              <img src="icons/pencil.svg" class="icon-svg" alt="" />
              <span>${isRenaming ? 'Save' : 'Edit'}</span>
            </button>
          </div>
        </div>
      </div>
      ${isRenaming
        ? `<input
            class="page-rename-input"
            type="text"
            value="${escapeHtml(state.renamingPageValue || page.title || 'Untitled page')}"
            aria-label="Edit saved page title"
            data-page-rename-input="${page.id}"
            maxlength="160"
          />`
        : `<h3>${escapeHtml(page.title || 'Untitled page')}</h3>`}
      ${thumbnailMarkup}
      <p class="card-url">${escapeHtml(page.url)}</p>
      <p class="card-snippet">${escapeHtml(page.snippet || 'No preview text captured for this page.')}</p>
    `;

    const renameButton = card.querySelector('.rename-button');
    if (renameButton) {
      renameButton.addEventListener('click', async (event) => {
        event.stopPropagation();

        if (isRenaming) {
          await commitPageRename(page);
          return;
        }

        beginPageRename(page);
      });
    }

    const deleteButton = card.querySelector('.delete-button');
    deleteButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deletePage(page.id);
    });

    deleteButton.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deletePage(page.id);
    });

    const renameInput = card.querySelector('.page-rename-input');
    if (renameInput) {
      renameInput.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      renameInput.addEventListener('input', (event) => {
        state.renamingPageValue = event.target.value;
      });

      renameInput.addEventListener('keydown', async (event) => {
        event.stopPropagation();

        if (event.key === 'Enter') {
          event.preventDefault();
          await commitPageRename(page);
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          cancelPageRename();
        }
      });

      renameInput.addEventListener('blur', async () => {
        if (state.renamingPageId !== page.id) {
          return;
        }

        await commitPageRename(page);
      });
    }

    fragment.appendChild(card);
  }

  elements.savedPagesList.appendChild(fragment);
}

function renderSessions() {
  elements.sessionGroupsList.innerHTML = '';

  if (state.sessions.length === 0) {
    toggleVisibility(elements.sessionsEmptyState, true);
    return;
  }

  toggleVisibility(elements.sessionsEmptyState, false);
  const fragment = document.createDocumentFragment();

  for (const session of state.sessions) {
    const card = document.createElement('article');
    card.className = 'session-card';
    const isRenaming = state.renamingSessionId === session.id;
    card.tabIndex = isRenaming ? -1 : 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Restore ${session.name || 'saved session'}`);
    card.addEventListener('click', () => {
      if (isRenaming) {
        return;
      }

      restoreSession(session);
    });
    card.addEventListener('keydown', (event) => {
      if (isRenaming) {
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        restoreSession(session);
      }
    });

    const topDomains = session.items
      .slice(0, 3)
      .map((item) => getDomain(item.url))
      .join(' • ');

    card.innerHTML = `
      <div class="session-card-header">
        <div class="session-title-row">
          ${isRenaming
            ? `<input
                class="session-rename-input"
                type="text"
                value="${escapeHtml(state.renamingSessionValue || session.name || 'Quick session')}"
                aria-label="Edit session name"
                data-session-rename-input="${session.id}"
                maxlength="120"
              />`
            : `<strong>${escapeHtml(session.name || 'Quick session')}</strong>`}
        </div>
        <div class="card-actions">
          <span>${session.count || session.items.length} tabs</span>
          <div class="action-button-stack">
            <button class="delete-button" type="button" aria-label="Delete saved session group">
              <img src="icons/trash.svg" class="delete-icon" alt="" />
              <span>Delete</span>
            </button>
            <button class="icon-button rename-button" type="button" aria-label="Rename saved session">
              <img src="icons/pencil.svg" class="icon-svg" alt="" />
              <span>${isRenaming ? 'Save' : 'Edit'}</span>
            </button>
          </div>
        </div>
      </div>
      <p>${escapeHtml(topDomains || 'Saved web pages')}</p>
      <time>${formatDateTime(session.createdAt)}</time>
    `;

    const deleteButton = card.querySelector('.delete-button');
    deleteButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      await deleteSession(session.id);
    });

    deleteButton.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deleteSession(session.id);
    });

    const renameButton = card.querySelector('.rename-button');
    if (renameButton) {
      renameButton.addEventListener('click', async (event) => {
        event.stopPropagation();

        if (isRenaming) {
          await commitSessionRename(session);
          return;
        }

        beginSessionRename(session);
      });
    }

    const renameInput = card.querySelector('.session-rename-input');
    if (renameInput) {
      renameInput.addEventListener('click', (event) => {
        event.stopPropagation();
      });

      renameInput.addEventListener('input', (event) => {
        state.renamingSessionValue = event.target.value;
      });

      renameInput.addEventListener('keydown', async (event) => {
        event.stopPropagation();

        if (event.key === 'Enter') {
          event.preventDefault();
          await commitSessionRename(session);
          return;
        }

        if (event.key === 'Escape') {
          event.preventDefault();
          cancelSessionRename();
        }
      });

      renameInput.addEventListener('blur', async () => {
        if (state.renamingSessionId !== session.id) {
          return;
        }

        await commitSessionRename(session);
      });
    }

    fragment.appendChild(card);
  }

  elements.sessionGroupsList.appendChild(fragment);
}

async function restoreSession(session) {
  try {
    for (const item of session.items) {
      await createTab({ url: item.url, active: false });
    }
    showStatus(`Restored ${session.items.length} tabs.`, false);
  } catch (error) {
    console.error('Failed to restore session:', error);
    showStatus('Failed to restore one or more tabs.', true);
  }
}

async function openPage(url) {
  try {
    await createTab({ url });
  } catch (error) {
    console.error('Failed to open saved page:', error);
    showStatus('Failed to open that page.', true);
  }
}

function showStatus(message, isError) {
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = `status-banner ${isError ? 'status-error' : 'status-success'}`;
  elements.statusBanner.classList.remove('hidden');

  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    elements.statusBanner.classList.add('hidden');
  }, 3200);
}

function showLimitBanner(message) {
  elements.limitMessage.textContent = message;
  elements.limitBanner.classList.remove('hidden');
}

function hideLimitBanner() {
  elements.limitBanner.classList.add('hidden');
}

function setLoading(isLoading) {
  state.loading = isLoading;
  toggleVisibility(elements.loadingState, isLoading);
}

function toggleBusyButtons(isBusy) {
  elements.saveCurrentButton.disabled = isBusy;
  elements.saveSessionButton.disabled = isBusy;
  elements.clearAllButton.disabled = isBusy;
}

function toggleVisibility(element, visible) {
  element.classList.toggle('hidden', !visible);
}

function debounce(callback, delay) {
  let timeoutId = 0;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), delay);
  };
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function subsequenceSimilarity(query, word) {
  if (!query || !word) {
    return 0;
  }

  let index = 0;
  let matches = 0;

  while (index < word.length && matches < query.length) {
    if (word[index] === query[matches]) {
      matches += 1;
    }
    index += 1;
  }

  return matches / Math.max(query.length, word.length);
}

function normalizedEditSimilarity(query, word) {
  const maxLength = Math.max(query.length, word.length);
  if (!maxLength) {
    return 0;
  }

  if (Math.abs(query.length - word.length) > 4) {
    return 0;
  }

  const distance = levenshtein(query, word);
  return 1 - distance / maxLength;
}

function levenshtein(source, target) {
  const rows = source.length + 1;
  const cols = target.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    matrix[row][0] = row;
  }

  for (let col = 0; col < cols; col += 1) {
    matrix[0][col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      const cost = source[row - 1] === target[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }

  return matrix[source.length][target.length];
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function formatDateTime(isoString) {
  if (!isoString) {
    return 'Unknown time';
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'Unknown source';
  }
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
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