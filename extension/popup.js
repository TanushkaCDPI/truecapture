const BACKEND_DEFAULT = 'https://api.truecapture.global';
let backendUrl = BACKEND_DEFAULT;
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;
let currentVerifyUrl = '';

const views = {
  main: document.getElementById('main-view'),
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

// ── Photo / Webcam / Screen → open capture tab ───────────────────
// Extension tabs have camera/mic permission on Mac; popups do not.
function openCaptureTab(mode) {
  const url = chrome.runtime.getURL(`capture.html?mode=${mode}`);
  chrome.tabs.create({ url });
  window.close();
}

document.getElementById('btn-photo').addEventListener('click', () => openCaptureTab('photo'));
document.getElementById('btn-webcam').addEventListener('click', () => openCaptureTab('webcam'));
document.getElementById('btn-screen').addEventListener('click', () => openCaptureTab('screen'));


document.getElementById('btn-stop-rec').addEventListener('click', () => {
  clearInterval(recordingTimer);
  stopStream();
  showView('processing');

  const mimeType = mediaRecorder.mimeType || 'video/webm';
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    await signAndDownload(blob, `tab-recording.${ext}`, mimeType, 'tab');
  };
  mediaRecorder.stop();
});

document.getElementById('btn-cancel-rec').addEventListener('click', () => {
  clearInterval(recordingTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  stopStream();
  showView('main');
});

// ── Sign + Download (used by tab capture path) ───────────────────
async function signAndDownload(blob, filename, mimeType, source) {
  document.getElementById('processing-label').textContent = 'Signing with C2PA...';
  try {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('metadata', JSON.stringify({ source, capturedAt: new Date().toISOString() }));

    const response = await fetch(`${backendUrl}/sign`, { method: 'POST', body: form });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const hash = response.headers.get('X-Verify-Hash');
    currentVerifyUrl = response.headers.get('X-Verify-URL') || `https://www.truecapture.global/verify/${hash}`;

    document.getElementById('processing-label').textContent = 'Downloading signed file...';
    const signedBlob = await response.blob();
    const url = URL.createObjectURL(signedBlob);
    await chrome.downloads.download({ url, filename: `signed_${filename}`, saveAs: false });

    document.getElementById('verify-url-display').textContent = currentVerifyUrl;
    showView('result');
    try { await navigator.clipboard.writeText(currentVerifyUrl); } catch {}
  } catch (err) {
    showError(err.message);
  }
}

// ── Result / error ────────────────────────────────────────────────
document.getElementById('btn-copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentVerifyUrl);
  document.getElementById('btn-copy-link').textContent = 'Copied!';
  setTimeout(() => (document.getElementById('btn-copy-link').textContent = 'Copy Verify Link'), 1500);
});

document.getElementById('btn-done').addEventListener('click', () => showView('main'));
document.getElementById('btn-retry').addEventListener('click', () => showView('main'));

function showError(msg) {
  document.getElementById('error-message').textContent = msg;
  showView('error');
}

function stopStream() {
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
}

function getSupportedMimeType() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

loadSettings();
