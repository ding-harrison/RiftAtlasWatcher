/*
 * RiftAtlas Full Log Keeper — popup.
 *
 * Reads sessions straight from chrome.storage.local (it never talks to the
 * page), exports them as .txt / .json, and starts or stops the match recording.
 */
(() => {
  'use strict';

  const ATLAS_ORIGIN = 'https://play.riftatlas.com/';
  const SESSION_PREFIX = 'session:';

  // --- Export formats (pure; also used by the unit tests) ----------------------

  const pad = (n) => String(n).padStart(2, '0');

  /** Local time, e.g. "2026-11-17 22:46:12". */
  function formatTime(ms) {
    const d = new Date(ms);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  /** One captured line per row, exactly as displayed in-game. */
  function toTxt(session) {
    return session.entries.map((e) => e.text + '\n').join('');
  }

  function toJson(session) {
    return JSON.stringify(
      {
        id: session.id,
        startedAt: new Date(session.startedAt).toISOString(),
        url: session.url,
        entries: session.entries.map((e) => ({
          capturedAt: new Date(e.capturedAt).toISOString(),
          text: e.text,
        })),
        // Your hand each time it changed. Match `capturedAt` against the entries.
        hands: (session.hands || []).map((h) => ({
          capturedAt: new Date(h.capturedAt).toISOString(),
          cards: h.cards,
        })),
      },
      null,
      2
    );
  }

  /** Every session, oldest first, separated by a header line. */
  function allToTxt(sessions) {
    return [...sessions]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((s) => `==== Session started ${formatTime(s.startedAt)} ====\n${toTxt(s)}`)
      .join('\n');
  }

  function fileStem(session) {
    return 'riftatlas-log-' + formatTime(session.startedAt).replace(' ', '_').replace(/:/g, '-');
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { formatTime, toTxt, toJson, allToTxt, fileStem };
    return;
  }

  // --- Browser only from here --------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const els = {
    sessions: $('sessions'),
    empty: $('empty'),
    footer: $('footer'),
    exportAll: $('export-all'),
    deleteAll: $('delete-all'),
    recDot: $('rec-dot'),
    recText: $('rec-text'),
    recHint: $('rec-hint'),
    recButton: $('rec-button'),
    recError: $('rec-error'),
    nagToggle: $('nag-toggle'),
    version: $('version'),
    status: $('status'),
    statusText: $('status-text'),
    copyDetails: $('copy-details'),
  };

  let sessions = [];
  let recording = null;
  let saving = null;
  let activeTab = null;
  let busy = false;
  let timer = null;

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  // --- Sessions ----------------------------------------------------------------

  async function loadSessions() {
    const all = await chrome.storage.local.get(null);
    sessions = Object.keys(all)
      .filter((k) => k.startsWith(SESSION_PREFIX))
      .map((k) => ({ key: k, ...all[k] }))
      .filter((s) => Array.isArray(s.entries))
      .sort((a, b) => b.startedAt - a.startedAt); // newest first
    renderSessions();
  }

  function urlPath(url) {
    try {
      const u = new URL(url);
      return u.pathname + u.search;
    } catch (_) {
      return url || '';
    }
  }

  function button(label, onClick, className) {
    const b = document.createElement('button');
    b.textContent = label;
    if (className) b.className = className;
    b.addEventListener('click', onClick);
    return b;
  }

  function div(className, text) {
    const d = document.createElement('div');
    d.className = className;
    if (text != null) d.textContent = text;
    return d;
  }

  function renderSessions() {
    els.sessions.replaceChildren(
      ...sessions.map((s) => {
        const n = s.entries.length;
        const h = (s.hands || []).length;
        const head = div('session-head');
        head.append(
          div('', formatTime(s.startedAt)),
          div('session-count', `${n.toLocaleString()} ${n === 1 ? 'entry' : 'entries'}`)
        );
        const url = div('session-url', urlPath(s.url) + (h ? ` · ${h.toLocaleString()} hand ${h === 1 ? 'snapshot' : 'snapshots'}` : ''));
        url.title = s.url || '';
        const actions = div('session-actions');
        actions.append(
          button('Export .txt', () => download(fileStem(s) + '.txt', toTxt(s), 'text/plain')),
          button('Export .json', () => download(fileStem(s) + '.json', toJson(s), 'application/json')),
          button('Delete', () => chrome.storage.local.remove(s.key), 'danger')
        );
        const card = div('session');
        card.append(head, url, actions);
        return card;
      })
    );
    els.empty.hidden = sessions.length > 0;
    els.footer.hidden = sessions.length === 0;
  }

  els.exportAll.addEventListener('click', () => {
    download('riftatlas-logs-all.txt', allToTxt(sessions), 'text/plain');
  });

  els.deleteAll.addEventListener('click', async () => {
    const n = sessions.length;
    if (!confirm(`Delete all ${n} captured ${n === 1 ? 'session' : 'sessions'}? This cannot be undone.`)) return;
    await chrome.storage.local.remove(sessions.map((s) => s.key));
  });

  // --- Recording ---------------------------------------------------------------

  function elapsed(since) {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ':' + pad(Math.floor(s / 60) % 60) : Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  function renderRecording() {
    clearInterval(timer);
    const onAtlas = !!(activeTab && activeTab.url && activeTab.url.startsWith(ATLAS_ORIGIN));
    els.recDot.classList.toggle('on', !!recording);

    if (recording) {
      const tick = () => (els.recText.textContent = `Recording · ${elapsed(recording.startedAt)}`);
      tick();
      timer = setInterval(tick, 1000);
      els.recHint.textContent =
        activeTab && recording.tabId !== activeTab.id ? 'Recording another tab.' : 'Saved to Downloads when you stop.';
      els.recButton.textContent = 'Stop & save';
      els.recButton.className = 'stop';
      els.recButton.disabled = busy;
    } else {
      els.recText.textContent = saving ? 'Saving recording…' : 'Not recording';
      els.recHint.textContent = saving
        ? 'The .webm is being written to Downloads.'
        : onAtlas
          ? 'Records this tab’s video and sound to a .webm file.'
          : 'Open play.riftatlas.com in this tab to record.';
      els.recButton.textContent = 'Start recording';
      els.recButton.className = 'primary';
      els.recButton.disabled = busy || !onAtlas || !!saving;
    }
  }

  function showError(text) {
    els.recError.textContent = text || '';
    els.recError.hidden = !text;
  }

  async function loadRecording() {
    const state = await chrome.storage.session.get(['recording', 'saving', 'lastError']);
    recording = state.recording || null;
    saving = state.saving || null;
    showError(state.lastError);
    renderRecording();
  }

  els.recButton.addEventListener('click', async () => {
    busy = true;
    showError('');
    renderRecording();
    try {
      let res;
      if (recording) {
        res = await chrome.runtime.sendMessage({ type: 'stop-recording' });
      } else {
        // Minted here, inside the click, so Chrome accepts the capture request.
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
        res = await chrome.runtime.sendMessage({ type: 'start-recording', tabId: activeTab.id, streamId });
      }
      if (res && !res.ok) showError(res.error);
    } catch (err) {
      showError(String((err && err.message) || err));
    }
    busy = false;
    await loadRecording();
  });

  // --- Is capture working on this tab? -----------------------------------------

  const onAtlasTab = () => !!(activeTab && activeTab.url && activeTab.url.startsWith(ATLAS_ORIGIN));

  function askTab(detailed) {
    return chrome.tabs.sendMessage(activeTab.id, { type: 'status', detailed }).catch(() => null);
  }

  async function loadStatus() {
    if (!onAtlasTab()) return;
    const st = await askTab(false);
    els.status.hidden = false;
    els.copyDetails.hidden = false;
    let ok = false;
    let text;
    if (!st || st.error) {
      text = 'Not connected to this tab. Refresh the RiftAtlas tab, then open this again.';
      els.copyDetails.hidden = !st;
    } else if (st.version !== chrome.runtime.getManifest().version) {
      text = `This tab is still running v${st.version}. Refresh the RiftAtlas tab.`;
    } else if (st.mode === 'rows') {
      ok = true;
      text = `Watching this tab · ${st.rowsOnScreen} log lines on screen · ${st.saved} saved`;
      if (st.hand) text += ` · ${st.hand.length} in hand`;
    } else if (st.saved) {
      ok = true;
      text = `Watching this tab (auto-detect) · ${st.saved} saved`;
    } else {
      ok = true;
      text = 'Watching this tab · no game log on this page yet';
    }
    els.status.className = 'status ' + (ok ? 'ok' : 'warn');
    els.statusText.textContent = text;
  }

  els.copyDetails.addEventListener('click', async () => {
    const details = (await askTab(true)) || { error: 'no answer from the tab' };
    details.popupVersion = chrome.runtime.getManifest().version;
    details.browser = navigator.userAgent;
    try {
      await navigator.clipboard.writeText(JSON.stringify(details, null, 2));
      els.copyDetails.textContent = 'Copied';
    } catch (_) {
      els.copyDetails.textContent = 'Copy failed';
    }
    setTimeout(() => (els.copyDetails.textContent = 'Copy details'), 1500);
  });

  // --- Settings ----------------------------------------------------------------

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    els.nagToggle.checked = !settings || settings.nag !== false;
  }

  els.nagToggle.addEventListener('change', async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, nag: els.nagToggle.checked } });
  });

  // --- Live updates ------------------------------------------------------------

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session') {
      loadRecording();
    } else if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(SESSION_PREFIX))) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadSessions, 200);
    }
  });

  (async () => {
    try {
      [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) {}
    els.version.textContent = 'v' + chrome.runtime.getManifest().version;
    loadSettings();
    loadRecording();
    loadSessions();
    loadStatus();
    setInterval(loadStatus, 2000);
  })();
})();
