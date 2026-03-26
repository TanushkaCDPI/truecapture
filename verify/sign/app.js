const BACKEND_URL = 'https://api.truecapture.global';

// iOS detection — used only to decide Record Video behaviour at click time
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

// ── Take Photo: label → hidden file input (always) ───────────────
// No JS needed — the <label for="input-photo"> in HTML handles it.

document.getElementById('input-photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await processFile(file, { source: 'camera-photo', capturedAt: new Date().toISOString() });
  e.target.value = ''; // reset so same file can re-trigger
});

// ── Record Video button ───────────────────────────────────────────
document.getElementById('btn-record-video').addEventListener('click', () => {
  if (isIOS) {
    // iPhone: trigger hidden file input with capture="environment"
    document.getElementById('input-video').click();
  } else {
    // Android / Desktop: use MediaRecorder directly in browser
    openCamera();
  }
});

document.getElementById('input-video').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await processFile(file, { source: 'camera-video', capturedAt: new Date().toISOString() });
  e.target.value = '';
});

// ── MediaRecorder camera (Android / Desktop) ──────────────────────
let stream = null;
let recorder = null;
let chunks = [];
let timerInterval = null;
let timerSeconds = 0;
let facingMode = 'environment';

async function openCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: true,
    });
    const feed = document.getElementById('camera-feed');
    feed.srcObject = stream;
    await feed.play();
    document.getElementById('btn-shutter').className = 'shutter';
    showScreen('screen-camera');
  } catch (err) {
    showError('Camera access denied: ' + err.message);
  }
}

// Shutter starts recording
document.getElementById('btn-shutter').addEventListener('click', () => {
  if (!document.getElementById('btn-shutter').classList.contains('recording')) {
    startRecording();
  }
});

function startRecording() {
  chunks = [];
  timerSeconds = 0;
  const mimeType = getSupportedMimeType();
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(1000);
  document.getElementById('btn-shutter').classList.add('recording');
  document.getElementById('shutter-label').textContent = 'Recording';
  document.getElementById('rec-bar').classList.remove('rec-bar-hidden');
  timerInterval = setInterval(() => {
    timerSeconds++;
    const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
    const s = String(timerSeconds % 60).padStart(2, '0');
    document.getElementById('rec-time').textContent = `${m}:${s}`;
  }, 1000);
}

document.getElementById('btn-stop').addEventListener('click', () => {
  clearInterval(timerInterval);
  document.getElementById('rec-bar').classList.add('rec-bar-hidden');
  const mimeType = recorder.mimeType || 'video/webm';
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: mimeType });
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    await processFile(
      new File([blob], `video.${ext}`, { type: mimeType }),
      { source: 'camera-video', capturedAt: new Date().toISOString() }
    );
  };
  recorder.stop();
  stopStream();
  showScreen('screen-home');
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  stopStream();
  showScreen('screen-home');
});

document.getElementById('btn-flip').addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  stopStream();
  await openCamera();
});

// ── Sign ──────────────────────────────────────────────────────────
async function processFile(file, metadata) {
  showScreen('screen-processing');
  setStep('upload');

  try {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('metadata', JSON.stringify({ ...metadata, device: navigator.userAgent }));

    setStep('sign');
    document.getElementById('proc-msg').textContent = 'Signing with C2PA...';

    const res = await fetch(`${BACKEND_URL}/sign`, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Signing failed');
    }

    const verifyHash = res.headers.get('X-Verify-Hash');
    const verifyUrl = res.headers.get('X-Verify-URL') ||
      `https://www.truecapture.global/verify/${verifyHash}`;

    setStep('save');
    document.getElementById('proc-msg').textContent = 'Saving signed file...';

    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signed_${file.name}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    document.getElementById('verify-url').textContent = verifyUrl;
    showScreen('screen-result');
    try { await navigator.clipboard.writeText(verifyUrl); } catch {}

  } catch (err) {
    showError(err.message);
  }
}

function setStep(step) {
  const steps = ['upload', 'sign', 'save'];
  const idx = steps.indexOf(step);
  steps.forEach((s, i) => {
    const el = document.getElementById(`step-${s}`);
    if (i < idx) { el.classList.remove('active'); el.classList.add('done'); }
    else if (i === idx) { el.classList.add('active'); el.classList.remove('done'); }
    else el.classList.remove('active', 'done');
  });
}

document.getElementById('btn-copy').addEventListener('click', async () => {
  const url = document.getElementById('verify-url').textContent;
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById('btn-copy');
    btn.textContent = '✓ Copied!';
    setTimeout(() => {
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Link`;
    }, 2000);
  } catch {}
});

document.getElementById('btn-again').addEventListener('click', () => showScreen('screen-home'));
document.getElementById('btn-retry').addEventListener('click', () => showScreen('screen-home'));

// ── Helpers ───────────────────────────────────────────────────────
function showScreen(id) {
  const screens = ['screen-home', 'screen-processing', 'screen-result', 'screen-error'];
  screens.forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
  // Camera overlay is outside #app, handle separately
  const cam = document.getElementById('screen-camera');
  cam.classList.toggle('hidden', id !== 'screen-camera');
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  showScreen('screen-error');
}

function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

function getSupportedMimeType() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}
