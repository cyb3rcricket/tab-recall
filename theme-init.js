document.documentElement.setAttribute('data-theme', 'night');

try {
  chrome.storage.local.get(['theme'], (items) => {
    const theme = items?.theme === 'day' ? 'day' : 'night';
    document.documentElement.setAttribute('data-theme', theme);
  });
} catch {
  document.documentElement.setAttribute('data-theme', 'night');
}
