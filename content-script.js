chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'GET_PAGE_SNIPPET') {
    return false;
  }

  sendResponse({ snippet: extractSnippet() });
  return false;
});

function extractSnippet() {
  const candidates = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.querySelector('.post'),
    document.querySelector('.Post'),
    document.querySelector('.feed'),
    document.querySelector('#content'),
    document.body
  ];

  for (const node of candidates) {
    const text = collectVisibleText(node);
    if (text.length >= 40) {
      return text.slice(0, 260);
    }
  }

  return '';
}

function collectVisibleText(root) {
  if (!root) {
    return '';
  }

  const elements = root.querySelectorAll('p, h1, h2, h3, li, article, section, div, span');
  const chunks = [];

  for (const element of elements) {
    if (chunks.join(' ').length >= 600) {
      break;
    }

    if (!isVisible(element)) {
      continue;
    }

    const text = element.innerText?.trim();
    if (!text || text.length < 20) {
      continue;
    }

    chunks.push(text);
  }

  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}