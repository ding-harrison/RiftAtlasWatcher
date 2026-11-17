/*
 * RiftAtlas Full Log Keeper — service worker.
 *
 * Two jobs:
 *   1. Badge: live per-tab entry count, and a "REC?" nag while a match is
 *      being logged but not recorded.
 *   2. Recording control: mint a tabCapture stream ID, run the recorder in an
 *      offscreen document, and save the finished .webm through the downloads API.
 *
 * The worker can be suspended at any time, so all state lives in
 * chrome.storage.session (in-memory, cleared when the browser closes).
 */
'use strict';

const ATLAS_ORIGIN = 'https://play.riftatlas.com/';
const OFFSCREEN_URL = 'offscreen.html';
const NAG_TEXT = 'REC?';
const COLOR = { idle: '#5f6368', nag: '#e37400', recording: '#d93025' };

const session = chrome.storage.session;
const countKey = (tabId) => `count:${tabId}`;

// --- Badge --------------------------------------------------------------------

function formatCount(n) {
  return n > 999 ? '1k+' : String(n);
}

async function nagEnabled() {
  const { settings } = await chrome.storage.local.get('settings');
  return !settings || settings.nag !== false;
}

async function refreshBadge(tabId) {
  try {
    const key = countKey(tabId);
    const [state, nag] = await Promise.all([session.get(['recording', key]), nagEnabled()]);
    const count = state[key] || 0;
    const recordingThis = !!state.recording && state.recording.tabId === tabId;

    let text = count ? formatCount(count) : '';
    let color = COLOR.idle;
    let title = count
      ? `RiftAtlas Full Log Keeper — ${count} log ${count === 1 ? 'entry' : 'entries'} captured`
      : 'RiftAtlas Full Log Keeper';

    if (recordingThis) {
      color = COLOR.recording;
      if (!count) text = 'REC';
      title += ' · recording';
    } else if (count && nag) {
      text = NAG_TEXT;
      color = COLOR.nag;
      title += ' · not recording (click to start)';
    }

    await Promise.all([
      chrome.action.setBadgeText({ tabId, text }),
      chrome.action.setBadgeBackgroundColor({ tabId, color }),
      chrome.action.setTitle({ tabId, title }),
    ]);
    if (chrome.action.setBadgeTextColor) {
      await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    }
  } catch (_) {
    /* tab is gone */
  }
}

async function refreshAllBadges() {
  const all = await session.get(null);
  const tabIds = Object.keys(all)
    .filter((k) => k.startsWith('count:'))
    .map((k) => Number(k.slice(6)));
  if (all.recording && !tabIds.includes(all.recording.tabId)) tabIds.push(all.recording.tabId);
  await Promise.all(tabIds.map(refreshBadge));
}

// --- Recording ----------------------------------------------------------------

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Record the RiftAtlas tab to a local .webm file.',
  });
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
  } catch (_) {}
}

/**
 * Start recording `tabId`. `streamId` is supplied by the popup (which minted it
 * inside the user's click); the keyboard shortcut mints it here.
 */
async function startRecording(tabId, streamId) {
  const { recording, saving } = await session.get(['recording', 'saving']);
  if (recording) return { ok: false, error: 'A recording is already running.' };
  if (saving) return { ok: false, error: 'Still saving the previous recording — try again in a moment.' };
  try {
    if (!streamId) streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    const startedAt = Date.now();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start',
      streamId,
      tabId,
      startedAt,
      // Lets the recorder match the tab's shape instead of adding black bars.
      width: tab && tab.width,
      height: tab && tab.height,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'The recorder did not start.');
    await session.set({ recording: { tabId, startedAt }, lastError: null });
    await refreshBadge(tabId);
    return { ok: true };
  } catch (err) {
    const error = String((err && err.message) || err);
    await session.set({ lastError: error });
    await closeOffscreen();
    return { ok: false, error };
  }
}

async function stopRecording() {
  const { recording } = await session.get('recording');
  if (!recording) return { ok: true };
  try {
    // The offscreen document answers with 'recording-finished' once the file is assembled.
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    if (!res || !res.ok || res.state === 'idle') throw new Error('recorder gone');
  } catch (_) {
    // No recorder to stop (offscreen document died): just clear the state.
    await clearRecording();
    await closeOffscreen();
  }
  return { ok: true };
}

async function clearRecording() {
  await session.remove('recording');
  await refreshAllBadges();
}

/** The offscreen document finished a file: hand it to the downloads API. */
async function onRecordingFinished(msg) {
  await clearRecording();
  if (!msg.url) {
    await session.set({ lastError: msg.error || 'The recording was empty.' });
    await closeOffscreen();
    return;
  }
  try {
    const downloadId = await chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    await session.set({ saving: { downloadId, url: msg.url } });
  } catch (err) {
    await session.set({ lastError: 'Could not save the recording: ' + String((err && err.message) || err) });
    await closeOffscreen();
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current === 'in_progress') return;
  const { saving } = await session.get('saving');
  if (!saving || saving.downloadId !== delta.id) return;
  if (delta.state.current === 'interrupted') {
    await session.set({ lastError: 'Saving the recording was interrupted.' });
  }
  await session.remove('saving');
  // The blob lives in the offscreen document; closing it frees the memory.
  await closeOffscreen();
});

async function toggleRecording(tab) {
  const { recording } = await session.get('recording');
  if (recording) return stopRecording();
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith(ATLAS_ORIGIN)) {
    return { ok: false, error: 'Open play.riftatlas.com to record.' };
  }
  return startRecording(tab.id);
}

// --- Events -------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'count': // from the content script
      if (sender.tab && sender.tab.id != null) {
        const tabId = sender.tab.id;
        session.set({ [countKey(tabId)]: msg.count | 0 }).then(() => refreshBadge(tabId));
      }
      return;
    case 'start-recording': // from the popup
      startRecording(msg.tabId, msg.streamId).then(sendResponse);
      return true;
    case 'stop-recording': // from the popup
      stopRecording().then(sendResponse);
      return true;
    case 'recording-finished': // from the offscreen document
      onRecordingFinished(msg);
      return;
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-recording') toggleRecording(tab);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await session.remove(countKey(tabId));
  const { recording } = await session.get('recording');
  // Closing the recorded tab ends the capture; make sure the file is saved.
  if (recording && recording.tabId === tabId) stopRecording();
});

// A new page load starts a new session (or leaves Atlas): reset the tab's count.
// The content script reports the real number again as soon as it runs.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'loading') {
    await session.remove(countKey(tabId));
    refreshBadge(tabId);
  } else if (info.status === 'complete') {
    refreshBadge(tabId);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) refreshAllBadges();
});
