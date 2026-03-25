const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'photo'; // photo | webcam | screen

let backendUrl = 'https://api.truecapture.global';
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;
let isRecording = false;
let verifyUrl = '';

// Load backend URL from storage
chrome.storage.local.get(['backendUrl'], (result) => {
  if (result.backendUrl) backendUrl = result.backendUrl;
});

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  const label = document.getElementById('cam-label');

  try {
    if (mode === 'photo') {
      label.textContent = 'Photo — click to snap';
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
        audio: false,
      });
    } else if (mode === 'webcam') {
      label.textContent = 'Video — click to record';
      currentStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: true,
      });
    } else if (mode === 'screen') {
      label.textContent = 'Screen — click to record';
      currentStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always' },
        audio: true,
      });
      // If user cancels the picker, stream is null
      if (!currentStream) { window.close(); return; }
    }

    document.getElementById('preview').srcObject = currentStream;
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
      window.close();
    } else {
      showError(err.message);
    }
  }
}

// ── Shutter ──────────────────────────────────────────────────────
document.getElementById('btn-shutter').addEventListener('click', async () => {
  if (mode === 'photo') {
    await snapPhoto();
  } else if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
});

async function snapPhoto() {
  const video = document.getElementById('preview');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  stopStream();
  showProcessing();
  canvas.toBlob(
    (blob) => signAndDownload(blob, 'photo.jpg', 'image/jpeg', 'webcam'),
    'image/jpeg', 0.92
  );
}

function startRecording() {
  isRecording = true;
  recordedChunks = [];
  recordingSeconds = 0;

  const btn = document.getElementById('btn-shutter');
  btn.classList.add('recording');
  document.getElementById('cam-label').textContent = 'Recording — click to stop';
  document.getElementById('rec-badge').classList.remove('hidden');

  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(currentStream, { mimeType });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start(1000);

  recordingTimer = setInterval(() => {
    recordingSeconds++;
    const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
    const s = String(recordingSeconds % 60).padStart(2, '0');
    document.getElementById('rec-time').textContent = `${m}:${s}`;
  }, 1000);
}

function stopRecording() {
  clearInterval(recordingTimer);
  const mimeType = mediaRecorder.mimeType || 'video/webm';
  const source = mode === 'screen' ? 'screen' : 'webcam';
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    signAndDownload(blob, `recording.${ext}`, mimeType, source);
  };
  mediaRecorder.stop();
  stopStream();
  showProcessing();
}

// ── Sign & Download ───────────────────────────────────────────────
async function signAndDownload(blob, filename, mimeType, source) {
  setStep('upload');
  document.getElementById('proc-msg').textContent = 'Uploading...';

  try {
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('metadata', JSON.stringify({
      source,
      capturedAt: new Date().toISOString(),
      device: navigator.userAgent,
    }));

    setStep('sign');
    document.getElementById('proc-msg').textContent = 'Signing with C2PA...';

    const response = await fetch(`${backendUrl}/sign`, { method: 'POST', body: form });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const hash = response.headers.get('X-Verify-Hash');
    verifyUrl = response.headers.get('X-Verify-URL') || `https://www.truecapture.global/verify/${hash}`;

    setStep('download');
    document.getElementById('proc-msg').textContent = 'Saving signed file...';

    const signedBlob = await response.blob();
    const objUrl = URL.createObjectURL(signedBlob);
    await chrome.downloads.download({ url: objUrl, filename: `signed_${filename}`, saveAs: false });

    document.getElementById('verify-url').textContent = verifyUrl;
    showResult();

    try { await navigator.clipboard.writeText(verifyUrl); } catch {}

  } catch (err) {
    showError(err.message);
  }
}

// ── Result / error actions ────────────────────────────────────────
document.getElementById('btn-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(verifyUrl);
  document.getElementById('btn-copy').textContent = 'Copied!';
  setTimeout(() => { document.getElementById('btn-copy').textContent = 'Copy Verify Link'; }, 1500);
});

document.getElementById('btn-another').addEventListener('click', () => location.reload());
document.getElementById('btn-retry').addEventListener('click', () => location.reload());
document.getElementById('btn-close').addEventListener('click', () => window.close());

// ── Helpers ───────────────────────────────────────────────────────
function showProcessing() {
  document.getElementById('view-camera').style.display = 'none';
  document.getElementById('view-processing').style.display = 'flex';
}

function showResult() {
  document.getElementById('view-processing').style.display = 'none';
  document.getElementById('view-result').style.display = 'flex';
}

function showError(msg) {
  document.getElementById('view-camera').style.display = 'none';
  document.getElementById('view-processing').style.display = 'none';
  document.getElementById('err-msg').textContent = msg;
  document.getElementById('view-error').style.display = 'flex';
}

function setStep(step) {
  const order = ['upload', 'sign', 'download'];
  const idx = order.indexOf(step);
  order.forEach((s, i) => {
    const el = document.getElementById(`s-${s}`);
    el.className = 'step' + (i < idx ? ' done' : i === idx ? ' active' : '');
  });
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

init();
