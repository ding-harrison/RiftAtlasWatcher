/*
 * RiftAtlas Full Log Keeper — capture engine (content script).
 *
 * Runs on https://play.riftatlas.com/* and records every game-log line the
 * moment it renders, so the page's own rolling buffer can no longer lose it.
 * Read-only: this script never touches the page or the game state.
 *
 * Two capture modes:
 *
 *   1. Atlas log rows (normal). RiftAtlas draws its log newest-first, shows
 *      only the newest rows until you scroll, and re-creates a row whenever its
 *      "×2" repeat counter changes. So instead of tracking DOM nodes, every
 *      change to the log is read as "the newest N rows right now" and merged
 *      into the saved history by sequence alignment — re-drawn rows are
 *      recognised, new rows are appended, nothing is ever removed.
 *
 *   2. Auto-detect (fallback). If the row selector matches nothing — Atlas
 *      changed its markup — anything on the page that looks like a timestamped
 *      line is kept, tracked by DOM node.
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
     * CSS selector matching ONE ROW of the RiftAtlas game log.
     *
     * If RiftAtlas changes its page and the badge stops counting, fix it here:
     *   1. Open a match, right-click a log line → Inspect.
     *   2. In DevTools, find the element that wraps exactly one log line
     *      (its time, text and "×2" counter) — usually an <li>.
     *   3. Write a selector that matches every such row and nothing else.
     *
     * If this matches nothing, capture falls back to auto-detect (below), so
     * lines are still kept.
     */
    rowSelector: '[data-match-log-group] li',

    /* RiftAtlas lists the newest line first. Set false for an oldest-first log. */
    newestFirst: true,

    /*
     * Auto-detect only: CSS selector of the element containing the log.
     * Leave empty ('') to watch the whole page. Use it to stop auto-detect
     * from picking up other timestamped text such as chat. If the selector
     * matches nothing, the whole page is watched instead.
     */
    logContainerSelector: '',

    /*
     * Auto-detect only: what counts as a log line — text that starts with a
     * clock time followed by something else, e.g. "22:38 Moved Recruit…",
     * "9:05:12 PM Drew 1 card." (A bare "10:38 PM" is only a timestamp.)
     */
    linePattern: /^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\s+(?![AP]M$)\S/i,

    /*
     * The counter Atlas appends when it collapses repeats ("Drew 1 card.×2").
     * A line whose text only differs by this counter is the same line, updated.
     */
    repeatSuffix: /\s*×\s*(\d+)$/,

    /* Longer text than this is a container, not a single line. */
    maxLineLength: 500,

    /* How long to wait after the latest new line before writing to disk. */
    saveDebounceMs: 1000,
  };

  // --- Pure helpers (also used by the unit tests) -----------------------------

  const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?$/i;
  const TIME_PREFIX = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?\s+/i;

  function normalize(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  /** True if already-normalized text is a log line. */
  function isLineText(text) {
    return text.length <= CONFIG.maxLineLength && CONFIG.linePattern.test(text);
  }

  /**
   * RiftAtlas puts the time in its own element and spaces it with CSS, so the
   * raw text reads "22:38Moved Recruit…". Given the row's normalized text and
   * the text of its first text node, restore the space the player sees.
   */
  function withTimeSpace(text, firstTextNode) {
    const time = normalize(firstTextNode || '');
    if (!time || !TIME_ONLY.test(time) || !text.startsWith(time)) return text;
    const rest = text.slice(time.length);
    return !rest || /^\s/.test(rest) ? text : time + ' ' + rest;
  }

  /** "22:46 Drew 1 card.×3" → { base: "22:46 Drew 1 card.", body: "Drew 1 card.", count: 3 } */
  function splitLine(text) {
    const m = CONFIG.repeatSuffix.exec(text);
    const base = m ? text.slice(0, m.index) : text;
    return { base, body: base.replace(TIME_PREFIX, ''), count: m ? parseInt(m[1], 10) || 1 : 1 };
  }

  /**
   * Auto-detect mode: how a known node's new text relates to what we stored.
   * 'amend'  — the same line, edited in place: one text is a prefix of the
   *            other ("Drew 1 card." → "Drew 1 card.×2") or only the repeat
   *            counter changed ("…×2" → "…×3")
   * 'new'    — unrelated text: the node was recycled for a different line
   */
  function relation(oldText, newText) {
    if (oldText === newText) return 'same';
    if (newText.startsWith(oldText) || oldText.startsWith(newText)) return 'amend';
    return splitLine(oldText).base === splitLine(newText).base ? 'amend' : 'new';
  }

  /**
   * Merge what the log shows right now into the saved history.
   *
   * `entries`  saved lines, oldest first: [{ capturedAt, text }]  (mutated)
   * `win`      the rows currently on screen, oldest first: ["22:46 Drew 1 card.×2", …]
   * `now`      timestamp for lines seen for the first time
   *
   * The window is a view of the END of the real log, so it is aligned against
   * the tail of the history (longest common subsequence, preferring the most
   * recent match). Rows that line up are the same line — its repeat counter
   * only ever grows. Rows that do not line up are new and are inserted where
   * they belong. Saved lines missing from the window (scrolled out of the
   * rolling buffer, or undone by a rewind) are kept.
   *
   * Returns true if anything changed.
   */
  function mergeWindow(entries, win, now) {
    const W = win.filter(Boolean).map((text) => ({ text, ...splitLine(text) }));
    const m = W.length;
    if (!m) return false;

    const start = Math.max(0, entries.length - Math.max(400, 4 * m));
    const T = [];
    for (let i = start; i < entries.length; i++) T.push(splitLine(entries[i].text));
    const n = T.length;

    // lcs[i][j] = longest common subsequence of T[i:] and W[j:]
    const cols = m + 1;
    const lcs = new Uint32Array((n + 1) * cols);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * cols + j] =
          T[i].base === W[j].base
            ? lcs[(i + 1) * cols + j + 1] + 1
            : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
      }
    }

    let changed = false;
    const out = []; // rebuilt tail: { entry, matched }
    let i = 0;
    let j = 0;
    while (j < m) {
      if (i < n && lcs[(i + 1) * cols + j] === lcs[i * cols + j]) {
        // This saved line is not needed for the best alignment: keep it, move on.
        out.push({ entry: entries[start + i], split: T[i], matched: false });
        i++;
      } else if (i < n && T[i].base === W[j].base) {
        const entry = entries[start + i];
        if (W[j].count > T[i].count) {
          entry.text = W[j].text; // "…×2" → "…×3"
          changed = true;
        }
        out.push({ entry, split: T[i], matched: true });
        i++;
        j++;
      } else {
        // Not in the history at this position. Atlas stamps a collapsed row
        // with the time of its newest repeat, so "22:46 Drew 1 card." can
        // come back as "22:47 Drew 1 card.×2": same line, updated.
        let amended = false;
        if (W[j].count > 1) {
          for (let k = out.length - 1; k >= 0 && k >= out.length - 10 && !out[k].matched; k--) {
            if (out[k].split.body === W[j].body && out[k].split.count < W[j].count) {
              out[k].entry.text = W[j].text;
              out[k].split = W[j];
              out[k].matched = true;
              amended = true;
              break;
            }
          }
        }
        if (!amended) out.push({ entry: { capturedAt: now, text: W[j].text }, split: W[j], matched: true });
        changed = true;
        j++;
      }
    }
    for (; i < n; i++) out.push({ entry: entries[start + i] });

    if (changed) entries.splice(start, n, ...out.map((o) => o.entry));
    return changed;
  }

  // Node (unit tests): export the helpers and stop here.
  if (typeof module === 'object' && module.exports) {
    module.exports = { CONFIG, normalize, isLineText, withTimeSpace, splitLine, relation, mergeWindow };
    return;
  }

  // --- Browser only from here -------------------------------------------------

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
  const RAW_TEXT_LIMIT = CONFIG.maxLineLength * 20; // cheap guard before normalizing
  const TIME_START = /^\d{1,2}:\d{2}/;
  const MAX_ANCESTOR_WALK = 10;
  const MAX_SAVE_WAIT_MS = 5000;
  const RETRY_SAVE_MS = 5000;
  const CONTAINER_CHECK_MS = 2000;
  const RECONCILE_MIN_GAP_MS = 40;

  const startedAt = Date.now();
  const sessionId =
    new Date(startedAt).toISOString().replace(/[:.]/g, '-') +
    '#' +
    Math.random().toString(16).slice(2, 8).padEnd(6, '0');
  const storageKey = 'session:' + sessionId;
  const initialUrl = location.href;

  /** @type {{capturedAt:number, text:string}[]} */
  const entries = [];

  let dead = false; // extension reloaded/removed: stop quietly
  let dirty = false;
  let saveTimer = null;
  let firstDirtyAt = 0;
  let badgeTimer = null;
  let observer = null;
  let observedRoot = null;
  let containerTimer = null;

  // Atlas-rows mode
  let rowsSeen = false; // once true, auto-detect stays off for this page load
  let reconcileTimer = null;
  let lastReconcileAt = 0;
  const lastSignature = new WeakMap(); // log container → what it showed last time

  // Auto-detect mode: node identity is the only dedupe key.
  const nodeToEntry = new WeakMap();

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
    clearTimeout(reconcileTimer);
    clearInterval(containerTimer);
  }

  // --- Reading text -----------------------------------------------------------

  function firstTextNodeData(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.trim()) return node.data;
    }
    return '';
  }

  /** Normalized text of an element as the player reads it, or '' if unusable. */
  function elementText(el) {
    const raw = el.textContent;
    if (!raw || raw.length > RAW_TEXT_LIMIT) return '';
    const text = normalize(raw);
    return TIME_START.test(text) ? withTimeSpace(text, firstTextNodeData(el)) : text;
  }

  // --- Atlas-rows mode --------------------------------------------------------

  function findRows() {
    if (!CONFIG.rowSelector) return [];
    try {
      return document.querySelectorAll(CONFIG.rowSelector);
    } catch (_) {
      return []; // invalid selector: behave as if it matched nothing
    }
  }

  /** Read every log on the page and merge what it shows into the history. */
  function reconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
    lastReconcileAt = Date.now();
    const rows = findRows();
    if (!rows.length) return;
    rowsSeen = true;

    // The page may hold more than one copy of the log (layout variants).
    const windows = new Map();
    for (const row of rows) {
      const group = row.closest('[data-match-log-group]');
      const container = (group && group.parentElement) || row.parentElement || document.body;
      let texts = windows.get(container);
      if (!texts) windows.set(container, (texts = []));
      const text = elementText(row);
      if (text && text.length <= CONFIG.maxLineLength) texts.push(text);
    }

    let changed = false;
    for (const [container, texts] of windows) {
      const signature = texts.join('\n');
      if (lastSignature.get(container) === signature) continue;
      lastSignature.set(container, signature);
      if (CONFIG.newestFirst) texts.reverse();
      if (mergeWindow(entries, texts, Date.now())) changed = true;
    }
    if (changed) markDirty();
  }

  function scheduleReconcile() {
    if (reconcileTimer) return;
    const wait = lastReconcileAt + RECONCILE_MIN_GAP_MS - Date.now();
    if (wait <= 0) reconcile();
    else reconcileTimer = setTimeout(reconcile, wait);
  }

  // --- Auto-detect mode -------------------------------------------------------

  /** Normalized line text of an element, or null if it is not a log line. */
  function lineText(el) {
    if (SKIP_TAGS.has(el.tagName)) return null;
    const text = elementText(el);
    return text && isLineText(text) ? text : null;
  }

  /** Innermost match only: a panel of 50 lines also "starts with a time". */
  function hasLineDescendant(el) {
    for (const d of el.getElementsByTagName('*')) {
      if (lineText(d) !== null) return true;
    }
    return false;
  }

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
      entry.text = text; // "Drew 1 card." → "Drew 1 card.×2"
      markDirty();
    } else {
      addEntry(el, text); // recycled node — never overwrite the old line
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

  function autoDetect(mutations) {
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
  }

  // --- Observing --------------------------------------------------------------

  function onMutations(mutations) {
    if (!alive()) return;
    try {
      if (rowsSeen || findRows().length) {
        rowsSeen = true;
        scheduleReconcile();
      } else {
        autoDetect(mutations);
      }
    } catch (_) {
      /* never throw into the page */
    }
  }

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
    // Lines already on screen.
    if (findRows().length) reconcile();
    else if (!rowsSeen) sweep(root);
  }

  /**
   * Atlas-rows mode always watches the whole page. Auto-detect watches the
   * configured container when it exists, the whole page otherwise.
   */
  function attach() {
    if (!alive()) return;
    try {
      const container = rowsSeen || findRows().length ? null : findContainer();
      const want = container || document.body;
      if (want && want !== observedRoot) observe(want);
    } catch (_) {}
  }

  // --- Persistence ------------------------------------------------------------

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

  /** Flush on the way out so the end of a match is never lost. */
  function flush() {
    try {
      if (rowsSeen && alive()) reconcile();
    } catch (_) {}
    save();
  }

  function reportCount() {
    badgeTimer = null;
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage({ type: 'count', count: entries.length }).catch(() => {});
    } catch (_) {}
  }

  // --- Start ------------------------------------------------------------------

  function start() {
    reportCount(); // fresh page load: reset this tab's badge
    attach();
    if (CONFIG.logContainerSelector) {
      // The SPA may mount the container later, or replace it; keep following it.
      containerTimer = setInterval(attach, CONTAINER_CHECK_MS);
    }
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
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
