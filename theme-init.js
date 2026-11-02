try {
  const cached = localStorage.getItem('theme');
  if (cached === 'day' || cached === 'night') {
    document.documentElement.setAttribute('data-theme', cached);
  }
} catch { /* Fall back to extension storage. */ }

try {
  chrome.storage.local.get(['theme'], (items) => {
    const theme = items?.theme === 'day' ? 'day' : 'night';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* Extension storage remains authoritative. */ }
  });
} catch {
  document.documentElement.setAttribute('data-theme', 'night');
}
