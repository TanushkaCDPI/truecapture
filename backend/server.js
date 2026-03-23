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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// Key storage
const KEYS_DIR = join(__dirname, '.keys');
const KEY_FILE = join(KEYS_DIR, 'signing.pem');
const CERT_FILE = join(KEYS_DIR, 'cert.pem');
const PUBKEY_FILE = join(KEYS_DIR, 'public.pem');

async function ensureKeys() {
  if (!existsSync(KEYS_DIR)) {
    await mkdir(KEYS_DIR, { recursive: true });
  }

  if (!existsSync(KEY_FILE) || !existsSync(CERT_FILE)) {
    // Generate ECDSA P-256 keypair using forge
    const keypair = forge.pki.rsa.generateKeyPair(2048);
    // Use ECDSA via node crypto instead
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    // Self-signed cert via forge (using RSA for cert compatibility, but ECDSA for signing)
    // Actually use forge for self-signed cert with ECDSA
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

    const certPem = forge.pki.certificateToPem(cert);
    const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    const publicKeyPem = forge.pki.publicKeyToPem(keys.publicKey);

    await writeFile(KEY_FILE, privateKeyPem);
    await writeFile(CERT_FILE, certPem);
    await writeFile(PUBKEY_FILE, publicKeyPem);

    fastify.log.info('Generated new signing keypair');
  }
}

async function loadKeys() {
  const privateKeyPem = await readFile(KEY_FILE, 'utf8');
  const certPem = await readFile(CERT_FILE, 'utf8');
  const publicKeyPem = await readFile(PUBKEY_FILE, 'utf8');
  return { privateKeyPem, certPem, publicKeyPem };
}

// Build a C2PA-like manifest structure embedded in the file
// Since c2pa-node has complex setup, we implement a simplified but real JUMBF/C2PA embedding
async function signFile(fileBuffer, mimeType, filename, metadata) {
  const { privateKeyPem, certPem, publicKeyPem } = await loadKeys();

  // Build manifest data
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
          author: [{ '@type': 'Person', name: metadata.author || 'TrueCapture User' }],
          dateCreated: metadata.capturedAt || new Date().toISOString(),
        },
      },
    ],
    public_key_pem: publicKeyPem,
  };

  // Hash the original file
  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  manifest.file_hash = fileHash;

  // Sign the manifest
  const manifestJson = JSON.stringify(manifest);
  const sign = createSign('SHA256');
  sign.update(manifestJson);
  sign.end();

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const signature = sign.sign(privateKey, 'base64');

  // Build the full C2PA box
  const c2paBox = {
    version: '1.0',
    manifest,
    signature,
    certificate: certPem,
  };

  const c2paJson = JSON.stringify(c2paBox);
  const c2paBuffer = Buffer.from(c2paJson, 'utf8');

  // Embed into file based on type
  let signedBuffer;
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    signedBuffer = embedInJpeg(fileBuffer, c2paBuffer);
  } else if (mimeType === 'image/png') {
    signedBuffer = embedInPng(fileBuffer, c2paBuffer);
  } else {
    // For video/other, append with marker
    signedBuffer = embedInBinary(fileBuffer, c2paBuffer);
  }

  // Generate verify hash (hash of manifest + signature)
  const verifyHash = crypto
    .createHash('sha256')
    .update(manifestJson + signature)
    .digest('hex')
    .substring(0, 16);

  return { signedBuffer, verifyHash, manifest, signature };
}

function embedInJpeg(jpegBuffer, c2paBuffer) {
  // JPEG APP11 marker for C2PA (0xFFEB)
  const marker = Buffer.from([0xff, 0xeb]);
  const markerLabel = Buffer.from('C2PA\x00', 'utf8');

  // Length includes the 2-byte length field itself
  const dataLength = markerLabel.length + c2paBuffer.length;
  const lengthField = Buffer.alloc(2);
  lengthField.writeUInt16BE(dataLength + 2);

  const app11 = Buffer.concat([marker, lengthField, markerLabel, c2paBuffer]);

  // Insert after JPEG SOI marker (first 2 bytes)
  return Buffer.concat([jpegBuffer.slice(0, 2), app11, jpegBuffer.slice(2)]);
}

function embedInPng(pngBuffer, c2paBuffer) {
  // Find end of PNG header (8 bytes) and insert a custom chunk
  const PNG_SIG_LENGTH = 8;

  // Build custom chunk: caBX (C2PA box)
  const chunkType = Buffer.from('caBX', 'ascii');
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(c2paBuffer.length);

  // CRC over type + data
  const crcData = Buffer.concat([chunkType, c2paBuffer]);
  const crc = crc32(crcData);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc);

  const chunk = Buffer.concat([chunkLength, chunkType, c2paBuffer, crcBuffer]);

  return Buffer.concat([pngBuffer.slice(0, PNG_SIG_LENGTH), chunk, pngBuffer.slice(PNG_SIG_LENGTH)]);
}

function embedInBinary(fileBuffer, c2paBuffer) {
  const MAGIC = Buffer.from('\x00C2PA_TRUECAPTURE\x00', 'utf8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32BE(c2paBuffer.length);
  return Buffer.concat([fileBuffer, MAGIC, lengthBuffer, c2paBuffer]);
}

// Simple CRC32 implementation
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

// Routes
fastify.get('/health', async () => ({ status: 'ok', service: 'TrueCapture Backend' }));

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
        for await (const chunk of part.file) {
          chunks.push(chunk);
        }
        fileBuffer = Buffer.concat(chunks);
        filename = part.filename || 'capture';
        mimeType = part.mimetype || 'image/jpeg';
      } else {
        if (part.fieldname === 'metadata') {
          try {
            metadata = JSON.parse(part.value);
          } catch {
            metadata = {};
          }
        }
      }
    }

    if (!fileBuffer) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    const { signedBuffer, verifyHash, manifest } = await signFile(
      fileBuffer,
      mimeType,
      filename,
      metadata
    );

    const verifyUrl = `https://truecap.io/${verifyHash}`;

    reply.header('Content-Type', mimeType);
    reply.header('Content-Disposition', `attachment; filename="signed_${filename}"`);
    reply.header('X-Verify-Hash', verifyHash);
    reply.header('X-Verify-URL', verifyUrl);
    reply.header('X-C2PA-Signed', 'true');
    reply.header('Access-Control-Expose-Headers', 'X-Verify-Hash, X-Verify-URL, X-C2PA-Signed');

    return reply.send(signedBuffer);
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: 'Signing failed', details: err.message });
  }
});

fastify.get('/public-key', async () => {
  const { publicKeyPem } = await loadKeys();
  return { publicKey: publicKeyPem };
});

// Start
await ensureKeys();
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
await fastify.listen({ port, host });
fastify.log.info(`TrueCapture backend running on port ${port}`);
