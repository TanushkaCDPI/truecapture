const BACKEND_URL = 'https://47bbe865d638e0.lhr.life'; // Change to production URL

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isAndroid = /Android/.test(navigator.userAgent);

let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;
let cameraFacingMode = 'environment'; // rear camera default
let currentMode = 'photo';

// Detect platform and show appropriate UI
function initPlatform() {
  if (isIOS) {
    document.getElementById('ios-capture').classList.remove('hidden');
  } else {
    document.getElementById('android-capture').classList.remove('hidden');
  }
}

// Screen management
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = '';
  });
  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    target.style.display = 'flex';
  }
}

// ── iOS HANDLERS ─────────────────────────────────────────────────
document.getElementById('ios-video-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await processFile(file, { source: 'iphone-camera', capturedAt: new Date().toISOString() });
});

document.getElementById('ios-photo-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await processFile(file, { source: 'iphone-camera', capturedAt: new Date().toISOString() });
});

// ── ANDROID/DESKTOP VIDEO ────────────────────────────────────────
document.getElementById('btn-start-video').addEventListener('click', async () => {
  await openCamera('video');
});

document.getElementById('btn-start-photo').addEventListener('click', async () => {
  await openCamera('photo');
});

async function openCamera(mode) {
  currentMode = mode;
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: mode === 'video',
    });
    const feed = document.getElementById('camera-feed');
    feed.srcObject = currentStream;
    await feed.play();
    showScreen('screen-camera');

    const btn = document.getElementById('btn-shutter');
    const label = document.getElementById('mode-label');
    btn.dataset.mode = mode;
    label.textContent = mode === 'video' ? 'Video' : 'Photo';
    btn.classList.remove('recording');
  } catch (err) {
    showError('Camera access denied: ' + err.message);
  }
}

// Shutter button
document.getElementById('btn-shutter').addEventListener('click', async () => {
  const btn = document.getElementById('btn-shutter');
  const mode = btn.dataset.mode;

  if (mode === 'photo') {
    await capturePhoto();
  } else if (mode === 'video' && !btn.classList.contains('recording')) {
    startVideoRecording();
  }
});

async function capturePhoto() {
  const feed = document.getElementById('camera-feed');
  const canvas = document.createElement('canvas');
  canvas.width = feed.videoWidth;
  canvas.height = feed.videoHeight;
  canvas.getContext('2d').drawImage(feed, 0, 0);

  stopStream();
  showScreen('screen-home');

  canvas.toBlob(async (blob) => {
    await processFile(
      new File([blob], 'photo.jpg', { type: 'image/jpeg' }),
      { source: 'android-camera', capturedAt: new Date().toISOString() }
    );
  }, 'image/jpeg', 0.92);
}

function startVideoRecording() {
  recordedChunks = [];
  recordingSeconds = 0;

  const btn = document.getElementById('btn-shutter');
  btn.classList.add('recording');
  document.getElementById('mode-label').textContent = 'Recording';

  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(currentStream, { mimeType });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start(1000);

  // Show overlay
  document.getElementById('rec-overlay').classList.remove('hidden');
  recordingTimer = setInterval(() => {
    recordingSeconds++;
    const m = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
    const s = String(recordingSeconds % 60).padStart(2, '0');
    document.getElementById('rec-time').textContent = `${m}:${s}`;
  }, 1000);
}

document.getElementById('btn-stop-recording').addEventListener('click', () => {
  clearInterval(recordingTimer);
  document.getElementById('rec-overlay').classList.add('hidden');

  const mimeType = mediaRecorder.mimeType || 'video/webm';
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    await processFile(
      new File([blob], `video.${ext}`, { type: mimeType }),
      { source: 'android-camera', capturedAt: new Date().toISOString() }
    );
  };
  mediaRecorder.stop();
  stopStream();
  showScreen('screen-home');
});

// Camera cancel & flip
document.getElementById('btn-cam-cancel').addEventListener('click', () => {
  stopStream();
  showScreen('screen-home');
});

document.getElementById('btn-flip').addEventListener('click', async () => {
  cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
  stopStream();
  await openCamera(currentMode);
});

// File upload
document.getElementById('file-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await processFile(file, { source: 'upload', capturedAt: new Date().toISOString() });
});

// ── PROCESS & SIGN ───────────────────────────────────────────────
async function processFile(file, metadata) {
  showScreen('screen-processing');
  setStep('upload');

  try {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('metadata', JSON.stringify({ ...metadata, device: navigator.userAgent }));

    setStep('sign');
    document.getElementById('processing-msg').textContent = 'Signing with C2PA...';

    const response = await fetch(`${BACKEND_URL}/sign`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      throw new Error(err.error || 'Signing failed');
    }

    const verifyHash = response.headers.get('X-Verify-Hash');
    const verifyUrl = response.headers.get('X-Verify-URL') || `https://www.truecapture.global/verify/${verifyHash}`;

    setStep('download');
    document.getElementById('processing-msg').textContent = 'Saving signed file...';

    const signedBlob = await response.blob();
    const signedFilename = `signed_${file.name}`;

    // Trigger download
    const url = URL.createObjectURL(signedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = signedFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    // Show result
    document.getElementById('result-verify-url').textContent = verifyUrl;
    showScreen('screen-result');

    // Auto-copy on mobile
    try {
      await navigator.clipboard.writeText(verifyUrl);
    } catch {}

  } catch (err) {
    showError(err.message);
  }
}

function setStep(step) {
  const steps = ['upload', 'sign', 'download'];
  const idx = steps.indexOf(step);
  steps.forEach((s, i) => {
    const el = document.getElementById(`step-${s}`);
    if (i < idx) { el.classList.remove('active'); el.classList.add('done'); }
    else if (i === idx) { el.classList.add('active'); el.classList.remove('done'); }
    else { el.classList.remove('active', 'done'); }
  });
}

// Result actions
document.getElementById('btn-copy-verify').addEventListener('click', async () => {
  const url = document.getElementById('result-verify-url').textContent;
  try {
    await navigator.clipboard.writeText(url);
    const btn = document.getElementById('btn-copy-verify');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Link`;
    }, 1500);
  } catch {}
});

document.getElementById('btn-capture-again').addEventListener('click', () => showScreen('screen-home'));
document.getElementById('btn-try-again').addEventListener('click', () => showScreen('screen-home'));

function showError(msg) {
  document.getElementById('error-detail').textContent = msg;
  showScreen('screen-error');
}

function stopStream() {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
}

function getSupportedMimeType() {
  const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

// Init
initPlatform();
showScreen('screen-home');
