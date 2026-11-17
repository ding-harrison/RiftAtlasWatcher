/*
 * RiftAtlas Full Log Keeper — capture engine (content script).
 *
 * Runs on https://play.riftatlas.com/* and records every game-log line the
 * moment it renders, so the page's own rolling buffer can no longer lose it.
 * Read-only: this script never touches the page or the game state.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIG — the only values you should ever need to edit.
  // After editing, click the reload arrow on chrome://extensions and refresh
  // the RiftAtlas tab.
  // ---------------------------------------------------------------------------
  const CONFIG = {
    /*
     * CSS selector of the element that contains the game log.
     *
     * Leave empty ('') to auto-detect: the whole page is watched and anything
     * that looks like a log line is kept. That works out of the box, but can
     * also pick up other timestamped text such as chat messages.
     *
     * To restrict capture to the log panel only:
     *   1. Open a match on play.riftatlas.com and right-click a log line → Inspect.
     *   2. In DevTools, walk up the Elements tree until the highlighted box
     *      covers the whole log panel (all lines, nothing else).
     *   3. Right-click that element → Copy → Copy selector, and paste it here,
     *      e.g. logContainerSelector: '#game-log'  or  '.log-panel > ul'
     *      Prefer a short id/class over a long auto-generated chain.
     *
     * If the selector matches nothing (typo, or Atlas changed its markup),
     * capture silently falls back to the whole page, so you never lose lines.
     */
    logContainerSelector: '',

    /*
     * What counts as a log line: text that starts with a clock time followed
     * by something else, e.g. "22:38 Moved Recruit…", "9:05:12 PM Drew 1 card."
     * (A bare "10:38 PM" is only a timestamp, not a line — hence the lookahead.)
     */
    linePattern: /^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\s+(?![AP]M$)\S/i,

    /*
     * The counter Atlas appends when it collapses repeats ("Drew 1 card.×2").
     * A line whose text only differs by this counter is the same line, updated.
     */
    repeatSuffix: /\s*×\s*\d+$/,

    /* Longer text than this is a container, not a single line. */
    maxLineLength: 500,

    /* How long to wait after the latest new line before writing to disk. */
    saveDebounceMs: 1000,
  };

  // --- Pure helpers (also used by the unit tests) -----------------------------

  function normalize(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  /** True if already-normalized text is a log line. */
  function isLineText(text) {
    return text.length <= CONFIG.maxLineLength && CONFIG.linePattern.test(text);
  }

  /**
   * How a known node's new text relates to what we stored for it.
   * 'amend'  — the same line, edited in place: one text is a prefix of the
   *            other ("Drew 1 card." → "Drew 1 card.×2") or only the repeat
   *            counter changed ("…×2" → "…×3")
   * 'new'    — unrelated text: the node was recycled for a different line
   */
  function relation(oldText, newText) {
    if (oldText === newText) return 'same';
    if (newText.startsWith(oldText) || oldText.startsWith(newText)) return 'amend';
    const base = (t) => t.replace(CONFIG.repeatSuffix, '');
    return base(oldText) === base(newText) ? 'amend' : 'new';
  }

  // Node (unit tests): export the helpers and stop here.
  if (typeof module === 'object' && module.exports) {
    module.exports = { CONFIG, normalize, isLineText, relation };
    return;
  }

  // --- Browser only from here -------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
  const RAW_TEXT_LIMIT = CONFIG.maxLineLength * 20; // cheap guard before normalizing
  const MAX_ANCESTOR_WALK = 10;
  const MAX_SAVE_WAIT_MS = 5000;
  const RETRY_SAVE_MS = 5000;
  const CONTAINER_CHECK_MS = 2000;

  const startedAt = Date.now();
  const sessionId =
    new Date(startedAt).toISOString().replace(/[:.]/g, '-') +
    '#' +
    Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  const storageKey = 'session:' + sessionId;
  const initialUrl = location.href;

  /** @type {{capturedAt:number, text:string}[]} */
  const entries = [];
  /** Node identity is the only dedupe key (FR-7). */
  const nodeToEntry = new WeakMap();

  let dead = false; // extension reloaded/removed: stop quietly
  let dirty = false;
  let saveTimer = null;
  let firstDirtyAt = 0;
  let badgeTimer = null;
  let observer = null;
  let observedRoot = null;
  let containerTimer = null;

  function alive() {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch (_) {
      /* fall through */
    }
    shutdown();
    return false;
  }

  function shutdown() {
    dead = true;
    try {
      if (observer) observer.disconnect();
    } catch (_) {}
    clearTimeout(saveTimer);
    clearTimeout(badgeTimer);
    clearInterval(containerTimer);
  }

  // --- Line detection ---------------------------------------------------------

  /** Normalized line text of an element, or null if it is not a log line. */
  function lineText(el) {
    if (SKIP_TAGS.has(el.tagName)) return null;
    const raw = el.textContent;
    if (!raw || raw.length > RAW_TEXT_LIMIT) return null;
    const text = normalize(raw);
    return isLineText(text) ? text : null;
  }

  /** Innermost match only: a panel of 50 lines also "starts with a time". */
  function hasLineDescendant(el) {
    for (const d of el.getElementsByTagName('*')) {
      if (lineText(d) !== null) return true;
    }
    return false;
  }

  // --- Recording entries ------------------------------------------------------

  function addEntry(el, text) {
    const entry = { capturedAt: Date.now(), text };
    entries.push(entry);
    nodeToEntry.set(el, entry);
    markDirty();
  }

  /** A node we already know changed (or was re-inserted): amend or append. */
  function updateKnown(el) {
    const entry = nodeToEntry.get(el);
    const text = lineText(el);
    if (text === null) return; // emptied / mid-update: keep what we have
    const rel = relation(entry.text, text);
    if (rel === 'same') return;
    if (hasLineDescendant(el)) return; // turned into a container; children are handled on their own
    if (rel === 'amend') {
      entry.text = text; // FR-5: "Drew 1 card." → "Drew 1 card.×2"
      markDirty();
    } else {
      addEntry(el, text); // FR-6: recycled node — never overwrite the old line
    }
  }

  /** Capture every line in a subtree (initial sweep and newly added nodes). */
  function sweep(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const matches = [];
    const consider = (el) => {
      if (nodeToEntry.has(el)) {
        updateKnown(el);
        if (lineText(el) !== null) matches.push({ el, known: true });
      } else {
        const text = lineText(el);
        if (text !== null) matches.push({ el, text, known: false });
      }
    };
    consider(root);
    for (const el of root.getElementsByTagName('*')) consider(el);

    // Elements come in document order, so a match is innermost exactly when
    // the next match is not one of its descendants.
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (m.known) continue;
      const next = matches[i + 1];
      if (next && m.el.contains(next.el)) continue;
      addEntry(m.el, m.text);
    }
  }

  /**
   * Text changed somewhere under `start`: walk up a few ancestors to find the
   * line that owns it, then amend it, append a recycled line, or record a new
   * line that only just became one.
   */
  function recheck(start) {
    let el = start;
    for (let i = 0; el && i <= MAX_ANCESTOR_WALK; i++, el = el.parentElement) {
      if (el === document.documentElement) break;
      // Ancestors only get longer: past this point nothing above can be a line.
      if ((el.textContent || '').length > RAW_TEXT_LIMIT) break;
      if (nodeToEntry.has(el)) {
        updateKnown(el);
        return;
      }
      const text = lineText(el);
      if (text !== null && !hasLineDescendant(el)) {
        addEntry(el, text);
        return;
      }
      if (el === observedRoot) break;
    }
  }

  function onMutations(mutations) {
    if (!alive()) return;
    try {
      const added = new Set();
      const changed = new Set();
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === Node.ELEMENT_NODE) added.add(n);
          }
          if (m.target.nodeType === Node.ELEMENT_NODE) changed.add(m.target);
        } else if (m.type === 'characterData') {
          if (m.target.parentElement) changed.add(m.target.parentElement);
        }
      }
      for (const el of added) if (el.isConnected) sweep(el);
      for (const el of changed) if (el.isConnected) recheck(el);
    } catch (_) {
      /* never throw into the page */
    }
  }

  // --- Scoping (FR-8) ---------------------------------------------------------

  function findContainer() {
    if (!CONFIG.logContainerSelector) return null;
    try {
      return document.querySelector(CONFIG.logContainerSelector);
    } catch (_) {
      return null; // invalid selector: behave as if it matched nothing
    }
  }

  function observe(root) {
    if (observer) observer.disconnect();
    observedRoot = root;
    observer = new MutationObserver(onMutations);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    sweep(root); // lines already on screen (FR-3); known nodes are skipped
  }

  /** Watch the configured container when it exists, the whole page otherwise. */
  function attach() {
    if (!alive()) return;
    try {
      const container = findContainer();
      const want = container || document.body;
      if (want && want !== observedRoot) observe(want);
    } catch (_) {}
  }

  // --- Persistence (FR-9, FR-10) ----------------------------------------------

  function markDirty() {
    if (!dirty) {
      dirty = true;
      firstDirtyAt = Date.now();
    }
    // Debounce after the latest new entry, but never starve under a steady stream.
    const wait = Math.max(
      0,
      Math.min(CONFIG.saveDebounceMs, firstDirtyAt + MAX_SAVE_WAIT_MS - Date.now())
    );
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, wait);
    if (!badgeTimer) badgeTimer = setTimeout(reportCount, 150);
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dirty || entries.length === 0 || !alive()) return;
    dirty = false;
    const record = { id: sessionId, startedAt, url: initialUrl, entries };
    const failed = () => {
      // Quota or transient failure: stay silent, try again shortly.
      if (!dirty) {
        dirty = true;
        firstDirtyAt = Date.now();
      }
      if (!saveTimer && !dead) saveTimer = setTimeout(save, RETRY_SAVE_MS);
    };
    try {
      chrome.storage.local.set({ [storageKey]: record }).catch(failed);
    } catch (_) {
      if (alive()) failed();
    }
  }

  function reportCount() {
    badgeTimer = null;
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ type: 'count', count: entries.length }).catch(() => {});
    } catch (_) {}
  }

  // --- Start (FR-1) -----------------------------------------------------------

  function start() {
    reportCount(); // fresh page load: reset this tab's badge
    attach();
    if (CONFIG.logContainerSelector) {
      // The SPA may mount the container later, or replace it; keep following it.
      containerTimer = setInterval(attach, CONTAINER_CHECK_MS);
    }
    // Flush on the way out so the end of a match is never lost.
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save();
    });
  }

  try {
    if (window.__riftAtlasLogKeeper) return;
    window.__riftAtlasLogKeeper = true;
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch (_) {
    /* never break the page */
  }
})();
