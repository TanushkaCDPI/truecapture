// Verify page — reads C2PA manifest from dropped/selected file, verifies signature, shows verdict

const BACKEND_URL = 'https://api.truecapture.global';
const BACKEND_PUBKEY_URL = `${BACKEND_URL}/public-key`;

// Check URL for expected hash
const urlHash = window.location.pathname.split('/').pop() ||
                new URLSearchParams(window.location.search).get('hash');

if (urlHash && /^[0-9a-f]{16}$/.test(urlHash)) {
  // Auto-verify from URL hash — no file upload needed
  autoVerifyFromHash(urlHash);
}

// Drop zone interactions
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
  console.log('[TrueCapture] File dropped:', file?.name, file?.type, file?.size);
  if (file) handleFileSelected(file);
});

// NOTE: do NOT add a click listener on the entire drop-zone that calls fileInput.click().
// The <label for="file-input"> in the HTML handles opening the picker natively.
// Adding a second programmatic .click() call double-triggers on iOS Safari and breaks selection.

// Listen on both 'change' and 'input' for maximum iOS Safari compatibility
function onFileInputChange(e) {
  const file = e.target.files && e.target.files[0];
  console.log('[TrueCapture] File input event:', e.type, file?.name, file?.type, file?.size);
  if (file) handleFileSelected(file);
}
fileInput.addEventListener('change', onFileInputChange);
fileInput.addEventListener('input', onFileInputChange);

function handleFileSelected(file) {
  console.log('[TrueCapture] handleFileSelected:', file.name, file.type, file.size);

  // Show immediate feedback so user knows something was received
  updateStatus(`File received: ${file.name}`);
  showSection('verifying-section');

  // Detect HEIC — iOS photo library exports HEIC which we cannot parse in-browser
  const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
    file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif');

  if (isHeic) {
    console.warn('[TrueCapture] HEIC file detected — not supported');
    showResult('unknown', {
      title: 'Unsupported Format',
      description: 'HEIC photos cannot be verified in the browser. Please export the photo as JPEG first: open it in Photos, tap Share → Save as JPEG, then select that file.',
      manifest: null,
    });
    return;
  }

  // Small timeout to let the browser paint the "verifying" screen before heavy work
  setTimeout(() => verifyFile(file), 50);
}

document.getElementById('btn-verify-another').addEventListener('click', () => {
  showSection('drop-section');
  fileInput.value = '';
});

function showSection(id) {
  ['drop-section', 'verifying-section', 'result-section'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.classList.toggle('hidden', s !== id);
  });
  // Drop section uses display style, not hidden class
  if (id === 'drop-section') {
    document.getElementById('drop-section').style.display = '';
  }
}

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

    const { manifest, signature, signedAt } = await res.json();

    updateStatus('Verifying cryptographic signature...');
    const manifestJson = JSON.stringify(manifest);
    const sigValid = await verifyWithManifestKey(manifestJson, signature, manifest.public_key_pem);
    const verifyHash = await computeVerifyHash(manifestJson, signature);

    let dediRecord = null;
    if (manifest.dedi_record_id && manifest.dedi_namespace && manifest.dedi_registry) {
      updateStatus('Looking up key registry (DeDi)...');
      dediRecord = await lookupDediRecord(
        manifest.dedi_namespace, manifest.dedi_registry, manifest.dedi_record_id
      );
    }

    updateStatus('Done.');

    if (sigValid) {
      showResult('authentic', {
        title: 'Authentic',
        description: 'This file has a valid C2PA signature. It was signed by TrueCapture and has not been tampered with.',
        manifest,
        signedAt,
        verifyHash,
        sigValid,
        hashMatch: null,
        dediRecord,
      });
    } else {
      showResult('tampered', {
        title: 'Invalid Signature',
        description: 'The cryptographic signature on this file is invalid.',
        manifest,
        signedAt,
        verifyHash,
        sigValid,
        hashMatch: null,
        dediRecord,
      });
    }
  } catch (err) {
    showResult('unknown', {
      title: 'Verification Error',
      description: 'An error occurred during verification: ' + err.message,
      manifest: null,
    });
  }
}

async function verifyFile(file) {
  console.log('[TrueCapture] verifyFile start:', file.name, file.type, file.size);
  updateStatus('Reading file...');

  try {
    const buffer = await readFileAsBuffer(file);
    console.log('[TrueCapture] File read complete, bytes:', buffer.byteLength);
    updateStatus('Extracting C2PA manifest...');

    const c2paBox = extractC2PAManifest(buffer, file.type);

    if (!c2paBox) {
      console.warn('[TrueCapture] No C2PA manifest found in file');
      showResult('unknown', {
        title: 'No C2PA Data Found',
        description: 'This file does not contain a TrueCapture C2PA manifest. It may not have been signed, or uses a different format.',
        manifest: null,
        fileHash: null,
      });
      return;
    }
    console.log('[TrueCapture] C2PA manifest found:', c2paBox?.manifest?.claim_generator);

    updateStatus('Verifying cryptographic signature...');
    const { manifest, signature, certificate } = c2paBox;

    // Verify the signature using the embedded public key (SPKI PEM)
    const manifestJson = JSON.stringify(manifest);
    const sigValid = await verifySignature(manifestJson, signature, manifest.public_key_pem || certificate);

    // Reconstruct original file by stripping the embedded C2PA block, then hash it
    updateStatus('Checking file integrity...');
    const originalBuffer = stripC2PABlock(buffer, file.type);
    const fileHashHex = await sha256hex(originalBuffer);
    const hashMatch = manifest.file_hash === fileHashHex;

    // Compute verify hash
    const verifyHash = await computeVerifyHash(manifestJson, signature);

    // Check against URL hash
    const urlHashMatch = !urlHash || verifyHash.startsWith(urlHash) || urlHash.startsWith(verifyHash);

    // Look up DeDi key registry if manifest has a record reference
    let dediRecord = null;
    if (manifest.dedi_record_id && manifest.dedi_namespace && manifest.dedi_registry) {
      updateStatus('Looking up key registry (DeDi)...');
      dediRecord = await lookupDediRecord(
        manifest.dedi_namespace,
        manifest.dedi_registry,
        manifest.dedi_record_id
      );
    }

    updateStatus('Done.');

    if (sigValid && hashMatch) {
      showResult('authentic', {
        title: 'Authentic',
        description: 'This file has a valid C2PA signature. The content has not been modified since it was signed by TrueCapture.',
        manifest,
        fileHash: fileHashHex,
        verifyHash,
        sigValid,
        hashMatch,
        urlHashMatch,
        dediRecord,
      });
    } else if (sigValid && !hashMatch) {
      showResult('tampered', {
        title: 'Tampered',
        description: 'The signature is cryptographically valid, but the file content has been modified since signing. The hash does not match.',
        manifest,
        fileHash: fileHashHex,
        verifyHash,
        sigValid,
        hashMatch,
        urlHashMatch,
        dediRecord,
      });
    } else {
      showResult('tampered', {
        title: 'Invalid Signature',
        description: 'The cryptographic signature is invalid. This file may have been tampered with or the signature is corrupt.',
        manifest,
        fileHash: fileHashHex,
        verifyHash,
        sigValid,
        hashMatch,
        urlHashMatch,
        dediRecord,
      });
    }

  } catch (err) {
    console.error('[TrueCapture] verifyFile error:', err);
    showResult('unknown', {
      title: 'Verification Error',
      description: 'An error occurred during verification: ' + err.message,
      manifest: null,
      fileHash: null,
    });
  }
}

// Strip the embedded C2PA block to reconstruct the original file for hashing
function stripC2PABlock(buffer, mimeType) {
  try {
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      const view = new DataView(buffer);
      let offset = 2;
      while (offset < buffer.byteLength - 4) {
        const marker = view.getUint16(offset, false);
        if (marker === 0xffeb) {
          const length = view.getUint16(offset + 2, false);
          const labelBytes = new Uint8Array(buffer, offset + 4, 5);
          if (new TextDecoder().decode(labelBytes) === 'C2PA\x00') {
            // Return buffer with APP11 block removed
            const before = new Uint8Array(buffer, 0, 2); // SOI
            const after = new Uint8Array(buffer, offset + 2 + length);
            const out = new Uint8Array(before.length + after.length);
            out.set(before, 0);
            out.set(after, before.length);
            return out.buffer;
          }
          offset += 2 + length;
        } else if ((marker & 0xff00) === 0xff00) {
          if (marker === 0xffda) break;
          offset += 2 + view.getUint16(offset + 2, false);
        } else { offset++; }
      }
    } else if (mimeType === 'image/png') {
      const view = new DataView(buffer);
      let offset = 8;
      while (offset < buffer.byteLength) {
        const length = view.getUint32(offset, false);
        const type = new TextDecoder().decode(new Uint8Array(buffer, offset + 4, 4));
        if (type === 'caBX') {
          const before = new Uint8Array(buffer, 0, offset);
          const after = new Uint8Array(buffer, offset + 12 + length);
          const out = new Uint8Array(before.length + after.length);
          out.set(before, 0); out.set(after, before.length);
          return out.buffer;
        }
        if (type === 'IEND') break;
        offset += 12 + length;
      }
    } else {
      // Binary: strip trailing magic+length+data block
      const MAGIC = new TextEncoder().encode('\x00C2PA_TRUECAPTURE\x00');
      const uint8 = new Uint8Array(buffer);
      for (let i = uint8.length - MAGIC.length - 4; i >= 0; i--) {
        let found = true;
        for (let j = 0; j < MAGIC.length; j++) {
          if (uint8[i + j] !== MAGIC[j]) { found = false; break; }
        }
        if (found) return buffer.slice(0, i);
      }
    }
  } catch {}
  return buffer; // fallback: no stripping
}

function extractC2PAManifest(buffer, mimeType) {
  try {
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      return extractFromJpeg(buffer);
    } else if (mimeType === 'image/png') {
      return extractFromPng(buffer);
    } else {
      return extractFromBinary(buffer);
    }
  } catch {
    return extractFromBinary(buffer);
  }
}

function extractFromJpeg(buffer) {
  const view = new DataView(buffer);

  // Look for APP11 marker (0xFFEB)
  let offset = 2; // Skip SOI
  while (offset < buffer.byteLength - 4) {
    const marker = view.getUint16(offset, false);
    if (marker === 0xffeb) {
      const length = view.getUint16(offset + 2, false);
      const dataOffset = offset + 4;

      // Check for C2PA label
      const decoder = new TextDecoder();
      const labelBytes = new Uint8Array(buffer, dataOffset, 5);
      const label = decoder.decode(labelBytes);

      if (label === 'C2PA\x00') {
        const jsonOffset = dataOffset + 5;
        const jsonLength = length - 2 - 5;
        const jsonBytes = new Uint8Array(buffer, jsonOffset, jsonLength);
        const jsonStr = new TextDecoder().decode(jsonBytes);
        return JSON.parse(jsonStr);
      }
      offset += 2 + length;
    } else if ((marker & 0xff00) === 0xff00) {
      if (marker === 0xffda) break; // SOS — stop
      const length = view.getUint16(offset + 2, false);
      offset += 2 + length;
    } else {
      offset++;
    }
  }
  return null;
}

function extractFromPng(buffer) {
  const sig = new Uint8Array(buffer, 0, 8);
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (sig[i] !== PNG_SIG[i]) throw new Error('Not a PNG');
  }

  const view = new DataView(buffer);
  let offset = 8;

  while (offset < buffer.byteLength) {
    const length = view.getUint32(offset, false);
    const typeBytes = new Uint8Array(buffer, offset + 4, 4);
    const type = new TextDecoder().decode(typeBytes);

    if (type === 'caBX') {
      const dataBytes = new Uint8Array(buffer, offset + 8, length);
      const jsonStr = new TextDecoder().decode(dataBytes);
      return JSON.parse(jsonStr);
    }

    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}

function extractFromBinary(buffer) {
  const MAGIC = '\x00C2PA_TRUECAPTURE\x00';
  const magicBytes = new TextEncoder().encode(MAGIC);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  // Search from end
  for (let i = uint8.length - magicBytes.length - 4; i >= 0; i--) {
    let found = true;
    for (let j = 0; j < magicBytes.length; j++) {
      if (uint8[i + j] !== magicBytes[j]) { found = false; break; }
    }
    if (found) {
      const jsonOffset = i + magicBytes.length + 4;
      const jsonLength = view.getUint32(i + magicBytes.length, false);
      const jsonBytes = new Uint8Array(buffer, jsonOffset, jsonLength);
      const jsonStr = new TextDecoder().decode(jsonBytes);
      return JSON.parse(jsonStr);
    }
  }
  return null;
}

async function verifySignature(data, signatureBase64, certPem) {
  try {
    // Extract public key from PEM cert
    const pemBody = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');

    const certDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

    // Import the certificate to extract public key
    // We'll use the built-in SubtleCrypto for RSASSA-PKCS1-v1_5
    const certKey = await crypto.subtle.importKey(
      'spki',
      // We need to extract SPKI from the cert
      // For simplicity, try to import directly
      certDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify']
    ).catch(() => null);

    if (!certKey) {
      // Try another approach - look for the public key in the manifest itself
      return await verifyWithManifestKey(data, signatureBase64, certPem);
    }

    const sigBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const dataBytes = new TextEncoder().encode(data);

    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      certKey,
      sigBytes,
      dataBytes
    );
  } catch {
    return await verifyWithManifestKey(data, signatureBase64, certPem);
  }
}

async function verifyWithManifestKey(data, signatureBase64, pemOrKey) {
  try {
    // Try to import as raw PEM public key
    const pemBody = pemOrKey
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/-----BEGIN RSA PUBLIC KEY-----/g, '')
      .replace(/-----END RSA PUBLIC KEY-----/g, '')
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');

    const keyDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

    const pubKey = await crypto.subtle.importKey(
      'spki',
      keyDer.buffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify']
    );

    const sigBytes = Uint8Array.from(atob(signatureBase64), c => c.charCodeAt(0));
    const dataBytes = new TextEncoder().encode(data);

    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      pubKey,
      sigBytes,
      dataBytes
    );
  } catch {
    return false;
  }
}

async function sha256hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeVerifyHash(manifestJson, signature) {
  const data = manifestJson + signature;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

async function lookupDediRecord(namespace, registry, recordId) {
  try {
    const res = await fetch(`${BACKEND_URL}/dedi-lookup/${encodeURIComponent(recordId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function readFileAsBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
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
    tampered: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    unknown: `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  document.getElementById('verdict-icon').innerHTML = icons[verdict];
  document.getElementById('verdict-title').textContent = data.title;
  document.getElementById('verdict-desc').textContent = data.description;

  if (data.manifest) {
    document.getElementById('manifest-details').style.display = '';
    document.getElementById('assertions-section').style.display = '';

    const m = data.manifest;
    const grid = document.getElementById('detail-grid');
    grid.innerHTML = '';

    const details = [
      ['Signed By', m.claim_generator || 'Unknown'],
      ['Signed At', data.signedAt ? new Date(data.signedAt).toLocaleString() : (m.created ? new Date(m.created).toLocaleString() : 'Unknown')],
      ['Captured At', m.captured_at ? new Date(m.captured_at).toLocaleString() : 'Unknown'],
      ['Source', m.source || 'Unknown'],
      ['Device', m.device || 'Unknown'],
      ['Format', m.format || 'Unknown'],
      ['Title', m.title || 'Untitled'],
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
    (m.assertions || []).forEach(a => {
      const item = document.createElement('div');
      item.className = 'assertion-item';
      item.innerHTML = `
        <div class="assertion-label">${escapeHtml(a.label)}</div>
        <div class="assertion-data">${escapeHtml(JSON.stringify(a.data, null, 2))}</div>
      `;
      list.appendChild(item);
    });
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

  if (data.hashMatch !== null && data.fileHash && data.manifest?.file_hash) {
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
