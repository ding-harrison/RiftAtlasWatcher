/*
 * RiftAtlas Full Log Keeper — recorder (offscreen document).
 *
 * Opens the tab stream the service worker minted, keeps the game audible,
 * and records to a single .webm. Lives independently of the service worker's
 * idle timeout, so one recording can span a whole Bo3.
 */
'use strict';

const RECORDING = {
  // First supported wins: VP9 per the spec, VP8 as the fallback.
  mimeTypes: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  videoBitsPerSecond: 2_500_000, // ≈ 1.1 GB per hour; plenty for a card table
  audioBitsPerSecond: 128_000,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFrameRate: 30,
  timesliceMs: 2000,
};

let recorder = null;
let stream = null;
let audioContext = null;
let chunks = [];
let meta = null; // { tabId, startedAt }
let finishing = false;

function pad(n) {
  return String(n).padStart(2, '0');
}

function fileName(startedAt) {
  const d = new Date(startedAt);
  return (
    `riftatlas-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.webm`
  );
}

/** Largest frame with the tab's aspect ratio that fits inside the maximum. */
function frameSize(width, height) {
  if (!(width > 0 && height > 0)) return { maxWidth: RECORDING.maxWidth, maxHeight: RECORDING.maxHeight };
  const scale = Math.min(RECORDING.maxWidth / width, RECORDING.maxHeight / height);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { maxWidth: even(width * scale), maxHeight: even(height * scale) };
}

async function start({ streamId, tabId, startedAt, width, height }) {
  if (recorder) throw new Error('A recording is already running.');
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: {
      mandatory: {
        ...source,
        ...frameSize(width, height),
        maxFrameRate: RECORDING.maxFrameRate,
      },
    },
  });

  // Capturing a tab mutes it for the player; route the audio back to the speakers.
  try {
    if (stream.getAudioTracks().length) {
      audioContext = new AudioContext();
      audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
    }
  } catch (_) {
    /* recording still works without passthrough */
  }

  const mimeType = RECORDING.mimeTypes.find((t) => MediaRecorder.isTypeSupported(t));
  chunks = [];
  meta = { tabId, startedAt };
  finishing = false;
  recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: RECORDING.videoBitsPerSecond,
    audioBitsPerSecond: RECORDING.audioBitsPerSecond,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  recorder.onstop = finish;
  recorder.onerror = stop;
  // Closing the recorded tab ends its tracks: stop and save what we have.
  for (const track of stream.getTracks()) track.addEventListener('ended', stop);
  recorder.start(RECORDING.timesliceMs);
}

function stop() {
  if (recorder && recorder.state !== 'inactive') recorder.stop(); // → onstop → finish
  else if (recorder) finish();
}

function finish() {
  if (finishing || !meta) return;
  finishing = true;
  const blob = new Blob(chunks, { type: 'video/webm' });
  const message = { type: 'recording-finished', tabId: meta.tabId, filename: fileName(meta.startedAt) };
  if (blob.size) message.url = URL.createObjectURL(blob);
  else message.error = 'The recording was empty.';

  try {
    for (const track of stream.getTracks()) track.stop();
  } catch (_) {}
  try {
    if (audioContext) audioContext.close();
  } catch (_) {}
  recorder = null;
  stream = null;
  audioContext = null;
  chunks = [];
  meta = null;

  // The service worker downloads the blob URL, then closes this document.
  chrome.runtime.sendMessage(message).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }
  if (msg.type === 'stop') {
    // 'stopping' → a file is on its way; 'finished' → it was already handed over
    // (e.g. the tab closed first); 'idle' → there was nothing to stop.
    const state = recorder ? 'stopping' : finishing ? 'finished' : 'idle';
    stop();
    sendResponse({ ok: true, state });
  }
});
