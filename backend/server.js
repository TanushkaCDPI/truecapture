import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { createSign } from 'crypto';
import forge from 'node-forge';

const __dirname = dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
});

await fastify.register(multipart, {
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ── Key storage paths ─────────────────────────────────────────────
const KEYS_DIR = join(__dirname, '.keys');
const KEY_FILE = join(KEYS_DIR, 'signing.pem');
const CERT_FILE = join(KEYS_DIR, 'cert.pem');
const PUBKEY_FILE = join(KEYS_DIR, 'public.pem');
const DEDI_REG_FILE = join(KEYS_DIR, 'dedi-registration.json');

// ── DeDi config from env ──────────────────────────────────────────
const DEDI_API = 'https://api.dedi.global';
const DEDI_API_KEY = process.env.DEDI_API_KEY;
const DEDI_NAMESPACE = process.env.DEDI_NAMESPACE;
const DEDI_REGISTRY = process.env.DEDI_REGISTRY || 'signing-keys';

// Module-level DeDi registration (set during startup)
let dediRegistration = null;

// ── Key generation ────────────────────────────────────────────────
async function ensureKeys() {
  if (!existsSync(KEYS_DIR)) {
    await mkdir(KEYS_DIR, { recursive: true });
  }

  if (!existsSync(KEY_FILE) || !existsSync(CERT_FILE)) {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [
      { name: 'commonName', value: 'TrueCapture Signer' },
      { name: 'organizationName', value: 'TrueCapture' },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    await writeFile(KEY_FILE, forge.pki.privateKeyToPem(keys.privateKey));
    await writeFile(CERT_FILE, forge.pki.certificateToPem(cert));
    await writeFile(PUBKEY_FILE, forge.pki.publicKeyToPem(keys.publicKey));

    fastify.log.info('Generated new signing keypair');
  }
}

async function loadKeys() {
  const privateKeyPem = await readFile(KEY_FILE, 'utf8');
  const certPem = await readFile(CERT_FILE, 'utf8');
  const publicKeyPem = await readFile(PUBKEY_FILE, 'utf8');
  return { privateKeyPem, certPem, publicKeyPem };
}

// ── DeDi registration ─────────────────────────────────────────────
async function ensureDediRegistration(publicKeyPem) {
  if (!DEDI_API_KEY || !DEDI_NAMESPACE) {
    fastify.log.warn('DeDi credentials not set — skipping key registry');
    return null;
  }

  // Already registered in this install?
  if (existsSync(DEDI_REG_FILE)) {
    const reg = JSON.parse(await readFile(DEDI_REG_FILE, 'utf8'));
    fastify.log.info(`DeDi: key already registered (record_id: ${reg.record_id})`);
    return reg;
  }

  // No local record — check if one already exists in the registry
  // (handles restarts after file was deleted, or initial seed)
  try {
    const queryRes = await fetch(`${DEDI_API}/dedi/query/${DEDI_NAMESPACE}/${DEDI_REGISTRY}`);
    if (queryRes.ok) {
      const body = await queryRes.json();
      const records = body?.data?.records || [];
      if (records.length > 0) {
        const existing = records[0];
        const reg = { record_id: existing.record_id, record_name: existing.record_name };
        await writeFile(DEDI_REG_FILE, JSON.stringify(reg, null, 2));
        fastify.log.info(`DeDi: adopted existing record (record_id: ${reg.record_id})`);
        return reg;
      }
    }
  } catch (err) {
    fastify.log.warn('DeDi: registry query failed, will attempt fresh registration:', err.message);
  }

  // Register the public key as a new record
  const recordName = `truecapture-${crypto.randomBytes(4).toString('hex')}`;

  try {
    const createRes = await fetch(
      `${DEDI_API}/dedi/${DEDI_NAMESPACE}/${DEDI_REGISTRY}/save-record-as-draft?publish=true`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DEDI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          record_name: recordName,
          description: 'TrueCapture signing key',
          details: {
            public_key_id: recordName,
            publicKey: publicKeyPem.trim(),
            keyType: 'Ecdsa',
            keyFormat: 'pem',
            entity: {
              name: 'TrueCapture',
              url: 'https://www.truecapture.global',
            },
          },
        }),
      }
    );

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${createRes.status}`);
    }

    fastify.log.info('DeDi: record created, querying for record_id...');

    // API returns no ID on create — query back to get it
    const query2 = await fetch(`${DEDI_API}/dedi/query/${DEDI_NAMESPACE}/${DEDI_REGISTRY}`);
    const body2 = await query2.json();
    const created = (body2?.data?.records || []).find(r => r.record_name === recordName);

    if (!created) {
      throw new Error('record not found after creation');
    }

    const reg = { record_id: created.record_id, record_name: recordName };
    await writeFile(DEDI_REG_FILE, JSON.stringify(reg, null, 2));
    fastify.log.info(`DeDi: key registered successfully (record_id: ${reg.record_id})`);
    return reg;

  } catch (err) {
    fastify.log.error('DeDi registration failed:', err.message);
    return null;
  }
}

// ── C2PA signing ──────────────────────────────────────────────────
async function signFile(fileBuffer, mimeType, filename, metadata) {
  const { privateKeyPem, certPem, publicKeyPem } = await loadKeys();

  const manifest = {
    claim_generator: 'TrueCapture/1.0',
    format: mimeType,
    title: filename,
    created: new Date().toISOString(),
    captured_at: metadata.capturedAt || new Date().toISOString(),
    source: metadata.source || 'camera',
    device: metadata.device || 'unknown',
    assertions: [
      {
        label: 'c2pa.actions',
        data: {
          actions: [
            {
              action: 'c2pa.created',
              when: metadata.capturedAt || new Date().toISOString(),
              softwareAgent: 'TrueCapture/1.0',
            },
          ],
        },
      },
      {
        label: 'stds.schema-org.CreativeWork',
        data: {
          '@context': 'https://schema.org/',
          '@type': 'CreativeWork',
          author: [{ '@type': 'Organization', name: 'TrueCapture', url: 'https://www.truecapture.global' }],
          dateCreated: metadata.capturedAt || new Date().toISOString(),
        },
      },
    ],
    public_key_pem: publicKeyPem,
    // DeDi key registry reference
    dedi_record_id: dediRegistration?.record_id || null,
    dedi_namespace: DEDI_NAMESPACE || null,
    dedi_registry: DEDI_REGISTRY,
  };

  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  manifest.file_hash = fileHash;

  const manifestJson = JSON.stringify(manifest);
  const sign = createSign('SHA256');
  sign.update(manifestJson);
  sign.end();

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = sign.sign(privateKey, 'base64');

  const c2paBox = { version: '1.0', manifest, signature, certificate: certPem };
  const c2paBuffer = Buffer.from(JSON.stringify(c2paBox), 'utf8');

  let signedBuffer;
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    signedBuffer = embedInJpeg(fileBuffer, c2paBuffer);
  } else if (mimeType === 'image/png') {
    signedBuffer = embedInPng(fileBuffer, c2paBuffer);
  } else {
    signedBuffer = embedInBinary(fileBuffer, c2paBuffer);
  }

  const verifyHash = crypto
    .createHash('sha256')
    .update(manifestJson + signature)
    .digest('hex')
    .substring(0, 16);

  return { signedBuffer, verifyHash, manifest, signature };
}

// ── File embedding ────────────────────────────────────────────────
function embedInJpeg(jpegBuffer, c2paBuffer) {
  const marker = Buffer.from([0xff, 0xeb]);
  const markerLabel = Buffer.from('C2PA\x00', 'utf8');
  const dataLength = markerLabel.length + c2paBuffer.length;
  const lengthField = Buffer.alloc(2);
  lengthField.writeUInt16BE(dataLength + 2);
  const app11 = Buffer.concat([marker, lengthField, markerLabel, c2paBuffer]);
  return Buffer.concat([jpegBuffer.slice(0, 2), app11, jpegBuffer.slice(2)]);
}

function embedInPng(pngBuffer, c2paBuffer) {
  const chunkType = Buffer.from('caBX', 'ascii');
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(c2paBuffer.length);
  const crcData = Buffer.concat([chunkType, c2paBuffer]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc);
  const chunk = Buffer.concat([chunkLength, chunkType, c2paBuffer, crcBuffer]);
  return Buffer.concat([pngBuffer.slice(0, 8), chunk, pngBuffer.slice(8)]);
}

function embedInBinary(fileBuffer, c2paBuffer) {
  const MAGIC = Buffer.from('\x00C2PA_TRUECAPTURE\x00', 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(c2paBuffer.length);
  return Buffer.concat([fileBuffer, MAGIC, lengthBuffer, c2paBuffer]);
}

function crc32(buf) {
  let crc = 0xffffffff;
  const table = makeCrcTable();
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrcTable() {
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}

// ── Manifest store (in-memory, keyed by verifyHash) ───────────────
const manifestStore = new Map();

// ── Server-side C2PA extraction ───────────────────────────────────
function serverExtractC2PA(buffer, mimeType) {
  try {
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      let offset = 2;
      while (offset < buffer.length - 4) {
        const marker = buffer.readUInt16BE(offset);
        if (marker === 0xffeb) {
          const length = buffer.readUInt16BE(offset + 2);
          if (buffer.slice(offset + 4, offset + 9).toString() === 'C2PA\x00') {
            return JSON.parse(buffer.slice(offset + 9, offset + 2 + length).toString('utf8'));
          }
          offset += 2 + length;
        } else if ((marker & 0xff00) === 0xff00) {
          if (marker === 0xffda) break;
          offset += 2 + buffer.readUInt16BE(offset + 2);
        } else { offset++; }
      }
    } else if (mimeType === 'image/png') {
      let offset = 8;
      while (offset < buffer.length) {
        const len = buffer.readUInt32BE(offset);
        const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
        if (type === 'caBX') return JSON.parse(buffer.slice(offset + 8, offset + 8 + len).toString('utf8'));
        if (type === 'IEND') break;
        offset += 12 + len;
      }
    } else {
      const MAGIC = Buffer.from('\x00C2PA_TRUECAPTURE\x00');
      for (let i = buffer.length - MAGIC.length - 4; i >= 0; i--) {
        if (buffer.slice(i, i + MAGIC.length).equals(MAGIC)) {
          const jsonLen = buffer.readUInt32BE(i + MAGIC.length);
          return JSON.parse(buffer.slice(i + MAGIC.length + 4, i + MAGIC.length + 4 + jsonLen).toString('utf8'));
        }
      }
    }
  } catch {}
  // Fallback: try binary scan regardless of mime type
  if (mimeType !== 'application/octet-stream') return serverExtractC2PA(buffer, 'application/octet-stream');
  return null;
}

function serverStripC2PA(buffer, mimeType) {
  try {
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      let offset = 2;
      while (offset < buffer.length - 4) {
        const marker = buffer.readUInt16BE(offset);
        if (marker === 0xffeb) {
          const length = buffer.readUInt16BE(offset + 2);
          if (buffer.slice(offset + 4, offset + 9).toString() === 'C2PA\x00') {
            return Buffer.concat([buffer.slice(0, 2), buffer.slice(offset + 2 + length)]);
          }
          offset += 2 + length;
        } else if ((marker & 0xff00) === 0xff00) {
          if (marker === 0xffda) break;
          offset += 2 + buffer.readUInt16BE(offset + 2);
        } else { offset++; }
      }
    } else if (mimeType === 'image/png') {
      let offset = 8;
      while (offset < buffer.length) {
        const len = buffer.readUInt32BE(offset);
        const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
        if (type === 'caBX') return Buffer.concat([buffer.slice(0, offset), buffer.slice(offset + 12 + len)]);
        if (type === 'IEND') break;
        offset += 12 + len;
      }
    } else {
      const MAGIC = Buffer.from('\x00C2PA_TRUECAPTURE\x00');
      for (let i = buffer.length - MAGIC.length - 4; i >= 0; i--) {
        if (buffer.slice(i, i + MAGIC.length).equals(MAGIC)) return buffer.slice(0, i);
      }
    }
  } catch {}
  return buffer;
}

async function dediLookup(recordId) {
  if (!DEDI_NAMESPACE || !DEDI_REGISTRY) return null;
  try {
    const res = await fetch(`${DEDI_API}/dedi/query/${DEDI_NAMESPACE}/${DEDI_REGISTRY}`);
    if (!res.ok) return null;
    const body = await res.json();
    const record = (body?.data?.records || []).find(r => r.record_id === recordId);
    if (!record) return null;
    return {
      record_id: record.record_id,
      record_name: record.record_name,
      state: record.state,
      created_at: record.created_at,
      entity: record.details?.entity || null,
      keyType: record.details?.keyType || null,
    };
  } catch { return null; }
}

// ── Routes ────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status: 'ok',
  service: 'TrueCapture Backend',
  dedi_registered: !!dediRegistration,
  dedi_record_id: dediRegistration?.record_id || null,
}));

fastify.post('/sign', async (request, reply) => {
  try {
    const parts = request.parts();
    let fileBuffer = null;
    let filename = 'capture';
    let mimeType = 'image/jpeg';
    let metadata = {};

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename || 'capture';
        mimeType = part.mimetype || 'image/jpeg';
      } else if (part.fieldname === 'metadata') {
        try { metadata = JSON.parse(part.value); } catch { metadata = {}; }
      }
    }

    if (!fileBuffer) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    const { signedBuffer, verifyHash, manifest, signature } = await signFile(
      fileBuffer, mimeType, filename, metadata
    );

    // Store manifest so the verify page can look it up by hash
    manifestStore.set(verifyHash, { manifest, signature, signedAt: new Date().toISOString() });

    const verifyUrl = `${process.env.VERIFY_BASE_URL || 'https://www.truecapture.global/verify'}/${verifyHash}`;

    reply.header('Content-Type', mimeType);
    reply.header('Content-Disposition', `attachment; filename="signed_${filename}"`);
    reply.header('X-Verify-Hash', verifyHash);
    reply.header('X-Verify-URL', verifyUrl);
    reply.header('X-C2PA-Signed', 'true');
    reply.header('X-Dedi-Record-Id', manifest.dedi_record_id || '');
    reply.header('Access-Control-Expose-Headers',
      'X-Verify-Hash, X-Verify-URL, X-C2PA-Signed, X-Dedi-Record-Id');

    return reply.send(signedBuffer);
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Signing failed', details: err.message });
  }
});

fastify.get('/manifest/:hash', async (request, reply) => {
  const entry = manifestStore.get(request.params.hash);
  if (!entry) return reply.status(404).send({ error: 'Not found' });
  return entry;
});

// POST /verify — server-side C2PA verification, works on all browsers/devices
fastify.post('/verify', async (request, reply) => {
  try {
    const parts = request.parts();
    let fileBuffer = null;
    let mimeType = 'application/octet-stream';

    for await (const part of parts) {
      if (part.type === 'file') {
        const chunks = [];
        for await (const chunk of part.file) chunks.push(chunk);
        fileBuffer = Buffer.concat(chunks);
        mimeType = part.mimetype || 'application/octet-stream';
      }
    }

    if (!fileBuffer) return reply.status(400).send({ error: 'No file provided' });

    const c2paBox = serverExtractC2PA(fileBuffer, mimeType);

    if (!c2paBox) {
      return {
        verdict: 'unsigned',
        title: 'No C2PA Data Found',
        description: 'This file does not contain a TrueCapture C2PA manifest. It may not have been signed with TrueCapture.',
        manifest: null,
      };
    }

    const { manifest, signature } = c2paBox;
    const manifestJson = JSON.stringify(manifest);

    // Verify the RSASSA-PKCS1-v1_5 / SHA-256 signature
    let sigValid = false;
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(manifestJson);
      sigValid = verify.verify(manifest.public_key_pem, signature, 'base64');
    } catch (err) {
      fastify.log.warn('Signature verification threw:', err.message);
    }

    // Strip the C2PA block then hash the original content
    const strippedBuffer = serverStripC2PA(fileBuffer, mimeType);
    const fileHash = crypto.createHash('sha256').update(strippedBuffer).digest('hex');
    const hashMatch = manifest.file_hash === fileHash;

    // Short verify hash (same algorithm as /sign uses)
    const verifyHash = crypto.createHash('sha256')
      .update(manifestJson + signature).digest('hex').substring(0, 16);

    // DeDi key registry lookup
    const dediRecord = manifest.dedi_record_id
      ? await dediLookup(manifest.dedi_record_id)
      : null;

    let verdict, title, description;
    if (sigValid && hashMatch) {
      verdict = 'authentic';
      title = 'Authentic';
      description = 'This file has a valid C2PA signature. The content has not been modified since it was signed by TrueCapture.';
    } else if (sigValid && !hashMatch) {
      verdict = 'tampered';
      title = 'Tampered';
      description = 'The signature is valid but the file content has been modified since signing. The hash does not match.';
    } else {
      verdict = 'tampered';
      title = 'Invalid Signature';
      description = 'The cryptographic signature is invalid. This file may have been tampered with or was not signed by TrueCapture.';
    }

    return { verdict, title, description, manifest, verifyHash, sigValid, hashMatch, fileHash, dediRecord };

  } catch (err) {
    fastify.log.error('POST /verify error:', err);
    return reply.status(500).send({ error: 'Verification failed', details: err.message });
  }
});

// Proxy DeDi record lookup — api.dedi.global returns 500 when Origin header
// is present (browser CORS), so the verify page calls this instead.
fastify.get('/dedi-lookup/:recordId', async (request, reply) => {
  const result = await dediLookup(request.params.recordId);
  if (!result) return reply.status(404).send({ error: 'Record not found' });
  return result;
});

fastify.get('/public-key', async () => {
  const { publicKeyPem } = await loadKeys();
  return {
    publicKey: publicKeyPem,
    dedi_record_id: dediRegistration?.record_id || null,
    dedi_namespace: DEDI_NAMESPACE || null,
    dedi_registry: DEDI_REGISTRY,
  };
});

// ── Start ─────────────────────────────────────────────────────────
await ensureKeys();
const { publicKeyPem } = await loadKeys();
dediRegistration = await ensureDediRegistration(publicKeyPem);

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
await fastify.listen({ port, host });
fastify.log.info(`TrueCapture backend running on port ${port}`);
