// Verify page — uploads file to backend for server-side C2PA verification.
// No client-side crypto or manifest parsing: works on all browsers including iOS Safari.

const BACKEND_URL = 'https://api.truecapture.global';

// Check URL for expected hash (truecapture.global/verify/<hash>)
const urlHash = window.location.pathname.split('/').pop() ||
                new URLSearchParams(window.location.search).get('hash');

if (urlHash && /^[0-9a-f]{16}$/.test(urlHash)) {
  autoVerifyFromHash(urlHash);
}

// Drop zone drag-and-drop for desktop
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// NOTE: handleFile is defined in index.html <head> and calls uploadAndVerify below.

document.getElementById('btn-verify-another').addEventListener('click', () => {
  window._handling = false;
  showSection('drop-section');
  fileInput.value = '';
});

// ── Server-side verification ──────────────────────────────────────
async function uploadAndVerify(file) {
  updateStatus('Uploading to server...');
  const formData = new FormData();
  formData.append('file', file);

  try {
    updateStatus('Verifying...');
    const res = await fetch(`${BACKEND_URL}/verify`, { method: 'POST', body: formData });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${res.status}`);
    }

    const data = await res.json();
    showResult(data.verdict || 'unknown', data);

  } catch (err) {
    console.error('[TrueCapture] uploadAndVerify error:', err);
    showResult('unknown', {
      title: 'Verification Error',
      description: 'Could not verify this file: ' + err.message,
      manifest: null,
    });
  }
}

// ── Hash-based auto-verify (from verify link) ─────────────────────
async function autoVerifyFromHash(hash) {
  showSection('verifying-section');
  updateStatus('Looking up signed file...');

  try {
    const res = await fetch(`${BACKEND_URL}/manifest/${hash}`);
    if (!res.ok) {
      showSection('drop-section');
      document.getElementById('expected-hash-box').style.display = 'block';
      document.getElementById('expected-hash-value').textContent = hash;
      return;
    }

    const { manifest, signedAt } = await res.json();

    // Manifest is in the store → was signed by this TrueCapture instance
    let dediRecord = null;
    if (manifest.dedi_record_id) {
      updateStatus('Looking up key registry (DeDi)...');
      try {
        const dediRes = await fetch(`${BACKEND_URL}/dedi-lookup/${encodeURIComponent(manifest.dedi_record_id)}`);
        if (dediRes.ok) dediRecord = await dediRes.json();
      } catch {}
    }

    showResult('authentic', {
      title: 'Authentic',
      description: 'This file was signed by TrueCapture and its provenance is verified.',
      manifest,
      signedAt,
      sigValid: true,
      hashMatch: null,
      verifyHash: hash,
      dediRecord,
    });

  } catch (err) {
    showResult('unknown', {
      title: 'Verification Error',
      description: 'An error occurred: ' + err.message,
      manifest: null,
    });
  }
}

// ── UI helpers ────────────────────────────────────────────────────
function showSection(id) {
  ['drop-section', 'verifying-section', 'result-section'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
  if (id === 'drop-section') {
    document.getElementById('drop-section').style.display = '';
  }
}

function updateStatus(msg) {
  document.getElementById('verify-status').textContent = msg;
}

function showResult(verdict, data) {
  showSection('result-section');

  const banner = document.getElementById('verdict-banner');
  banner.className = 'verdict ' + verdict;

  const icons = {
    authentic: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    tampered:  `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    unsigned:  `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    unknown:   `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  document.getElementById('verdict-icon').innerHTML = icons[verdict] || icons.unknown;
  document.getElementById('verdict-title').textContent = data.title;
  document.getElementById('verdict-desc').textContent = data.description;

  if (data.manifest) {
    document.getElementById('manifest-details').style.display = '';
    document.getElementById('assertions-section').style.display = '';

    const m = data.manifest;
    const grid = document.getElementById('detail-grid');
    grid.innerHTML = '';

    const details = [
      ['Signed By',       m.claim_generator || 'Unknown'],
      ['Signed At',       data.signedAt ? new Date(data.signedAt).toLocaleString() : (m.created ? new Date(m.created).toLocaleString() : 'Unknown')],
      ['Captured At',     m.captured_at ? new Date(m.captured_at).toLocaleString() : 'Unknown'],
      ['Source',          m.source || 'Unknown'],
      ['Device',          m.device || 'Unknown'],
      ['Format',          m.format || 'Unknown'],
      ['Title',           m.title || 'Untitled'],
      ['Signature Valid', data.sigValid !== undefined ? (data.sigValid ? '✓ Yes' : '✗ No') : 'N/A'],
    ];

    details.forEach(([key, value]) => {
      const item = document.createElement('div');
      item.className = 'detail-item';
      item.innerHTML = `<div class="key">${key}</div><div class="value">${escapeHtml(String(value))}</div>`;
      grid.appendChild(item);
    });

    const list = document.getElementById('assertions-list');
    list.innerHTML = '';

    if (m.assertions && m.assertions.length > 0) {
      // Build collapsed raw JSON block
      const rawJson = m.assertions.map(a =>
        `// ${a.label}\n${JSON.stringify(a.data, null, 2)}`
      ).join('\n\n');

      const pre = document.createElement('pre');
      pre.className = 'assertion-data';
      pre.style.display = 'none';
      pre.textContent = rawJson;

      const toggle = document.createElement('a');
      toggle.href = '#';
      toggle.className = 'assertions-toggle';
      toggle.textContent = 'Show technical details →';
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        const hidden = pre.style.display === 'none';
        pre.style.display = hidden ? 'block' : 'none';
        toggle.textContent = hidden ? 'Hide technical details ↑' : 'Show technical details →';
      });

      list.appendChild(toggle);
      list.appendChild(pre);
    }
  } else {
    document.getElementById('manifest-details').style.display = 'none';
    document.getElementById('assertions-section').style.display = 'none';
  }

  // DeDi identity panel
  const dediSection = document.getElementById('dedi-section');
  if (data.dediRecord) {
    const r = data.dediRecord;
    dediSection.style.display = '';
    const stateColor = r.state === 'live' ? 'var(--success)' : 'var(--warning)';
    dediSection.innerHTML = `
      <h3>Key Registry <span style="font-size:10px;font-weight:500;color:var(--muted);text-transform:none;letter-spacing:0">via DeDi.global</span></h3>
      <div class="dedi-card">
        <div class="dedi-row">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <div>
            <div class="dedi-name">${escapeHtml(r.entity?.name || 'Unknown')}</div>
            ${r.entity?.url ? `<a class="dedi-url" href="${escapeHtml(r.entity.url)}" target="_blank" rel="noopener">${escapeHtml(r.entity.url)}</a>` : ''}
          </div>
        </div>
        <div class="dedi-meta">
          <span class="dedi-badge" style="border-color:${stateColor};color:${stateColor}">${escapeHtml(r.state)}</span>
          <span>Registered ${r.created_at ? new Date(r.created_at).toLocaleDateString() : 'unknown'}</span>
          <span>Key type: ${escapeHtml(r.keyType || 'RSA')}</span>
        </div>
        <div class="dedi-id">Record ID: ${escapeHtml(r.record_id)}</div>
      </div>
    `;
  } else if (data.manifest?.dedi_record_id) {
    dediSection.style.display = '';
    dediSection.innerHTML = `
      <h3>Key Registry</h3>
      <div class="dedi-card" style="color:var(--muted)">
        <div class="dedi-id">Record ID: ${escapeHtml(data.manifest.dedi_record_id)}</div>
        <div style="font-size:12px;margin-top:6px">Could not fetch registry details — DeDi may be unavailable.</div>
      </div>
    `;
  } else {
    dediSection.style.display = 'none';
  }

  if (data.hashMatch !== null && data.hashMatch !== undefined && data.fileHash && data.manifest?.file_hash) {
    document.getElementById('hash-section').style.display = '';
    const compare = document.getElementById('hash-compare');
    const match = data.hashMatch;
    compare.innerHTML = `
      <div class="hash-row">
        <div class="hash-row-label">File hash</div>
        <div class="hash-row-value ${match ? 'hash-match' : 'hash-mismatch'}">${escapeHtml(data.fileHash)}</div>
      </div>
      <div class="hash-row">
        <div class="hash-row-label">Signed hash</div>
        <div class="hash-row-value ${match ? 'hash-match' : 'hash-mismatch'}">${escapeHtml(data.manifest.file_hash)}</div>
      </div>
      <div class="hash-result ${match ? 'match' : 'mismatch'}">
        ${match
          ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Hashes match — file integrity confirmed`
          : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Hash mismatch — file has been modified`}
      </div>
    `;
  } else {
    document.getElementById('hash-section').style.display = 'none';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
