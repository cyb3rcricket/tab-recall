# SecondShelf

**Stash pages before they vanish, then search and pull them back up at any time from your private, local dashboard.**

SecondShelf is a Chrome extension (Manifest V3) that turns your new-tab page into a personal web shelf. Bookmarks are where links go to be forgotten — SecondShelf is built for actually finding them again.

> **Naming note:** the extension itself is called **SecondShelf**. This repository is named `tab-recall`, after the thing it helps you do.

## What it does

- **Save a page** — right-click any page and choose Save to SecondShelf, or use the "Save Recent Web Tab" button on the dashboard.
- **Save a link** — right-click a link to shelve it without opening it first; selected text becomes its title.
- **Save a whole session** — one click stores all your open tabs as a named session group, and one click restores them later.
- **Find it again** — each save captures the title, URL, domain, a short snippet of the page's visible text, and a small thumbnail screenshot, so your shelf is visual, not just a list of links.
- **Typo-tolerant search** — search pages and sessions by title or URL, and pages by snippet, with close word matching.
- **No duplicates** — re-saving a page moves it to the top and refreshes available page details without replacing its title or thumbnail with a link or favicon fallback.
- **Make it yours** — rename or delete saved pages and sessions, switch between night and day themes, and see at a glance how much you've stored.

Clicking the toolbar icon opens (or focuses) your shelf — saving happens from the right-click menu and the dashboard buttons.

## Privacy

SecondShelf is local-first by design:

- Everything you save lives in your browser's local extension storage (`chrome.storage.local`) on your own device.
- There is no account, no server, no ads, and no tracking. The extension makes no external network calls with your saved pages.
- The broad host permission (`<all_urls>`) supports snippet capture when saving a background tab from the shelf, and screenshot capture. The extension injects its snippet reader only when you save a page; it does not run it automatically on every page.
- Right-click saves show a system notification with the result; browser or operating system notification settings can affect its visibility.

## Limits and Pro

The free version holds up to **500 saved pages**. An upgrade page exists in the extension as a placeholder — SecondShelf Pro (unlimited storage and pro features) is **not live yet**, and the free version stays fully local either way.

## Install (developer mode)

SecondShelf is not on the Chrome Web Store yet. To run it from this repo:

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or a Chromium browser).
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the repository folder.
5. Open a new tab — your shelf is there. Right-click any page to start saving.

## Tech

Plain HTML, CSS, and JavaScript — no build step and no dependencies.

Run the regression tests with `node --test tests/*.test.js` (Node.js required).

- `manifest.json` — Manifest V3 definition; the dashboard replaces the new-tab page.
- `service-worker.js` — saving, sessions, context menu, and storage mutations (serialized so saves can't race each other).
- `content-script.js` — extracts a short snippet of a page's visible text when you save it.
- `recall.html` / `recall.js` / `styles.css` — the dashboard: search, saved pages, and session groups.
- `upgrade.html` — the Pro placeholder page.

## License

MIT — see [LICENSE](LICENSE).
