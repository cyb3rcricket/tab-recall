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

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA') {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const chunks = [];
  let length = 0;

  while (walker.nextNode()) {
    const text = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 2) {
      continue;
    }

    chunks.push(text);
    length += text.length + 1;
    if (length >= 600) {
      break;
    }
  }

  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

function isVisible(element) {
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}
