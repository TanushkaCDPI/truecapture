const BACKEND_DEFAULT = 'http://localhost:3000';

let backendUrl = BACKEND_DEFAULT;
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;
let currentVerifyUrl = '';

// Views
const views = {
  main: document.getElementById('main-view'),
  camera: document.getElementById('camera-view'),
  recording: document.getElementById('recording-view'),
  processing: document.getElementById('processing-view'),
  result: document.getElementById('result-view'),
  error: document.getElementById('error-view'),
};

function showView(name) {
  Object.entries(views).forEach(([k, el]) => {
    el.classList.toggle('hidden', k !== name);
  });
}

// Load saved settings
async function loadSettings() {
  const stored = await chrome.storage.local.get(['backendUrl']);
  backendUrl = stored.backendUrl || BACKEND_DEFAULT;
  document.getElementById('backend-url').value = backendUrl;
}

document.getElementById('btn-save-url').addEventListener('click', async () => {
  const val = document.getElementById('backend-url').value.trim().replace(/\/$/, '');
  backendUrl = val || BACKEND_DEFAULT;
  await chrome.storage.local.set({ backendUrl });
  document.getElementById('btn-save-url').textContent = 'Saved!';
  setTimeout(() => (document.getElementById('btn-save-url').textContent = 'Save'), 1200);
});

// ── PHOTO ────────────────────────────────────────────────────────
document.getElementById('btn-photo').addEventListener('click', async () => {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    document.getElementById('camera-preview').srcObject = currentStream;
    showView('camera');
  } catch (err) {
    showError('Camera access denied: ' + err.message);
  }
});

document.getElementById('btn-snap').addEventListener('click', async () => {
  const video = document.getElementById('camera-preview');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  stopStream();
  showView('processing');

  canvas.toBlob(async (blob) => {
    await signAndDownload(blob, 'capture.jpg', 'image/jpeg', { source: 'webcam', capturedAt: new Date().toISOString() });
  }, 'image/jpeg', 0.92);
});

document.getElementById('btn-cancel-camera').addEventListener('click', () => {
  stopStream();
  showView('main');
});

// ── SCREEN RECORD ───────────────────────────────────────────────
document.getElementById('btn-screen').addEventListener('click', async () => {
  try {
    currentStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: true,
    });
    startRecording(currentStream, 'screen-recording.webm', 'screen');
  } catch (err) {
    if (err.name !== 'NotAllowedError') showError('Screen capture failed: ' + err.message);
  }
});

// ── WEBCAM VIDEO ────────────────────────────────────────────────
document.getElementById('btn-webcam').addEventListener('click', async () => {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    startRecording(currentStream, 'webcam-recording.webm', 'webcam');
  } catch (err) {
    showError('Camera access denied: ' + err.message);
  }
});

// ── TAB CAPTURE (Zoom/Meet) ──────────────────────────────────────
// tabCapture.capture must be called directly from an extension page (popup), not a service worker
document.getElementById('btn-tab').addEventListener('click', () => {
  chrome.tabCapture.capture({ audio: true, video: true }, (stream) => {
    if (chrome.runtime.lastError || !stream) {
      showError('Tab capture failed: ' + (chrome.runtime.lastError?.message || 'no stream'));
      return;
    }
    startRecording(stream, 'tab-recording.webm', 'tab');
  });
});

function startRecording(stream, filename, source) {
  currentStream = stream;
  recordedChunks = [];
  recordingSeconds = 0;

  const preview = document.getElementById('rec-preview');
  preview.srcObject = stream;
  showView('recording');

  document.getElementById('rec-label').textContent = source === 'screen' ? 'Recording Screen...' : source === 'tab' ? 'Recording Tab...' : 'Recording Webcam...';

  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(stream, { mimeType });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start(1000);

  recordingTimer = setInterval(() => {
    recordingSeconds++;
    const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
    const s = String(recordingSeconds % 60).padStart(2, '0');
    document.getElementById('rec-timer').textContent = `${m}:${s}`;
  }, 1000);

  // Auto-store filename + source for stop handler
  document.getElementById('btn-stop-rec')._filename = filename;
  document.getElementById('btn-stop-rec')._source = source;
  document.getElementById('btn-stop-rec')._mimeType = mimeType;
}

document.getElementById('btn-stop-rec').addEventListener('click', () => {
  const filename = document.getElementById('btn-stop-rec')._filename || 'recording.webm';
  const source = document.getElementById('btn-stop-rec')._source || 'screen';
  const mimeType = document.getElementById('btn-stop-rec')._mimeType || 'video/webm';

  clearInterval(recordingTimer);
  stopStream();
  showView('processing');

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    await signAndDownload(blob, filename, mimeType, { source, capturedAt: new Date().toISOString() });
  };
  mediaRecorder.stop();
});

document.getElementById('btn-cancel-rec').addEventListener('click', () => {
  clearInterval(recordingTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  stopStream();
  showView('main');
});

function getSupportedMimeType() {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

function stopStream() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
}

// ── SIGN + DOWNLOAD ──────────────────────────────────────────────
async function signAndDownload(blob, filename, mimeType, metadata) {
  document.getElementById('processing-label').textContent = 'Uploading to signing server...';

  try {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('metadata', JSON.stringify(metadata));

    document.getElementById('processing-label').textContent = 'Signing with C2PA...';

    const response = await fetch(`${backendUrl}/sign`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Server error' }));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const verifyHash = response.headers.get('X-Verify-Hash');
    const verifyUrl = response.headers.get('X-Verify-URL') || `https://truecap.io/${verifyHash}`;
    currentVerifyUrl = verifyUrl;

    document.getElementById('processing-label').textContent = 'Downloading signed file...';

    const signedBlob = await response.blob();
    const url = URL.createObjectURL(signedBlob);

    await chrome.downloads.download({
      url,
      filename: `signed_${filename}`,
      saveAs: false,
    });

    document.getElementById('verify-url-display').textContent = verifyUrl;
    showView('result');

    // Auto-copy to clipboard
    try {
      await navigator.clipboard.writeText(verifyUrl);
    } catch {}

  } catch (err) {
    showError(err.message);
  }
}

// ── RESULT ACTIONS ────────────────────────────────────────────────
document.getElementById('btn-copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentVerifyUrl);
  document.getElementById('btn-copy-link').textContent = 'Copied!';
  setTimeout(() => (document.getElementById('btn-copy-link').textContent = 'Copy Verify Link'), 1500);
});

document.getElementById('btn-done').addEventListener('click', () => showView('main'));
document.getElementById('btn-retry').addEventListener('click', () => showView('main'));

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showView('error');
}

loadSettings();
