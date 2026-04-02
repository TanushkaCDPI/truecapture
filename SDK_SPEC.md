# TrueCapture SDK — Technical Specification

**Version:** 0.1 (specification)
**Status:** Implementation in progress — see [Section 10](#10-status)
**License:** MIT
**Contact:** [tanushka@cdpi.dev](mailto:tanushka@cdpi.dev)

This document is written for engineering teams at news organisations, broadcasters, and institutions evaluating native app integration of C2PA media signing.

---

## 1. Overview

The TrueCapture SDK embeds C2PA media signing directly into any organisation's native iOS, Android, or React Native app. Organisations sign as themselves. A photo taken by a BBC journalist is signed *"Signed by BBC"* — not *"Signed by TrueCapture."* TrueCapture provides the library. The signing identity, keypair, and infrastructure are entirely the organisation's own.

**Three capabilities:**

- **Capture signing** — open the device camera, capture, and sign in a single call
- **Offline signing** — sign any file with zero connectivity; sync queues automatically when connection returns
- **Edit chain** (optional) — append a second manifest when a file is edited, preserving the full provenance chain

**Platforms:**

| Platform | Language | Status |
|----------|----------|--------|
| iOS | Swift | In progress — first release |
| React Native | JavaScript bridge | In progress — first release |
| Android | Kotlin | Planned |

---

## 2. Architecture

### Key storage

| Platform | Storage | Exportable |
|----------|---------|-----------|
| iOS | Secure Enclave | No |
| Android | Android Keystore | No |

The private key is generated on-device during first initialisation and never leaves the device. It is never transmitted to TrueCapture servers or any third party. Signing happens entirely on-device.

### Signing flow

```
Device (Secure Enclave / Android Keystore)
│
├── Camera capture or file input
├── SHA-256 hash of raw media bytes
├── C2PA manifest assembled locally
│     ├── file_hash
│     ├── captured_at timestamp
│     ├── org identity (orgName, orgDomain)
│     └── dedi_record_id (points to public key on DeDi.global)
├── ECDSA-P256 signature over manifest JSON
└── Manifest + signature embedded in file
      ├── JPEG  → APP11 segment
      ├── PNG   → caBX chunk
      └── Video → binary trailer
```

No file is sent to TrueCapture servers at any point during signing. The signed file is returned directly to the calling app.

### Public key registration

The organisation registers their public key on [DeDi.global](https://dedi.global) independently, before or after first use. The DeDi record ID is passed to `TrueCapture.configure()` and embedded in every manifest. Verifiers use it to confirm the signature belongs to the claimed organisation.

### Offline queue

When connectivity is unavailable:

- Signing proceeds normally on-device
- The verify hash is queued locally for upload to the verify backend
- DeDi sync (if needed) is queued locally
- A pending verify link is returned immediately — it activates once the queue syncs
- Files signed offline are indistinguishable from online-signed files once synced

---

## 3. Core Functions

### `TrueCapture.configure()`

Call once on app initialisation. Sets the signing identity for all subsequent operations.

**Swift**
```swift
import TrueCapture

TrueCapture.configure(
    orgName: "BBC",
    orgDomain: "bbc.com",
    dediRecordId: "your-dedi-record-id"
)
```

**Kotlin**
```kotlin
import dev.truecapture.TrueCapture

TrueCapture.configure(
    orgName = "BBC",
    orgDomain = "bbc.com",
    dediRecordId = "your-dedi-record-id"
)
```

**React Native**
```js
import TrueCapture from 'truecapture-sdk';

TrueCapture.configure({
  orgName: 'BBC',
  orgDomain: 'bbc.com',
  dediRecordId: 'your-dedi-record-id',
});
```

---

### `TrueCapture.captureAndSign()`

Opens the device camera, captures media, signs on-device, and returns the signed file and a verify link. Works fully offline.

**Swift**
```swift
let result = try await TrueCapture.captureAndSign(mediaType: .photo)

result.signedFile   // Data — the signed file, ready to save or share
result.verifyLink   // String — e.g. "https://verify.bbc.com/verify/a3f9c2e1b4d7f0e2"
result.syncStatus   // .synced | .pending
```

**Kotlin**
```kotlin
val result = TrueCapture.captureAndSign(mediaType = MediaType.PHOTO)

result.signedFile   // ByteArray
result.verifyLink   // String
result.syncStatus   // SyncStatus.SYNCED or SyncStatus.PENDING
```

**React Native**
```js
const result = await TrueCapture.captureAndSign({ mediaType: 'photo' });

result.signedFile   // base64 string
result.verifyLink   // string
result.syncStatus   // 'synced' | 'pending'
```

`mediaType` accepts `photo` or `video`.

---

### `TrueCapture.signExistingFile()`

Signs a file already captured — for organisations with their own camera UI. Same offline behaviour as `captureAndSign()`.

**Swift**
```swift
let result = try await TrueCapture.signExistingFile(
    file: imageData,
    mimeType: "image/jpeg",
    capturedAt: Date()
)
```

**Kotlin**
```kotlin
val result = TrueCapture.signExistingFile(
    file = imageByteArray,
    mimeType = "image/jpeg",
    capturedAt = Instant.now()
)
```

**React Native**
```js
const result = await TrueCapture.signExistingFile({
  file: base64Data,
  mimeType: 'image/jpeg',
  capturedAt: new Date().toISOString(),
});
```

---

### `TrueCapture.editAndResign()` [OPTIONAL]

Takes an original signed file and an edited version. Reads the original manifest (Manifest 1), assembles a second manifest (Manifest 2) referencing it, and signs with the organisation key. Returns the edited file with a full two-manifest chain embedded.

Only available when `enableEditChain: true` is passed to `configure()`. See [Section 5](#5-edit-chain-optional) for full details.

**Swift**
```swift
TrueCapture.configure(
    orgName: "BBC",
    orgDomain: "bbc.com",
    dediRecordId: "your-dedi-record-id",
    enableEditChain: true
)

let result = try await TrueCapture.editAndResign(
    original: originalSignedFile,
    edited: editedFile,
    editDescription: "Colour correction"
)
```

**Kotlin**
```kotlin
val result = TrueCapture.editAndResign(
    original = originalSignedFile,
    edited = editedFile,
    editDescription = "Colour correction"
)
```

**React Native**
```js
const result = await TrueCapture.editAndResign({
  original: originalBase64,
  edited: editedBase64,
  editDescription: 'Colour correction',
});
```

---

### `TrueCapture.verify()`

Verifies any C2PA signed file — from TrueCapture or any other C2PA-compliant tool. Returns a verdict and the full manifest. Works offline for files with the manifest embedded.

**Swift**
```swift
let verdict = try await TrueCapture.verify(file: fileData, mimeType: "image/jpeg")

verdict.result        // .authentic | .tampered | .unsigned
verdict.sigValid      // Bool
verdict.hashMatch     // Bool
verdict.manifest      // TrueCapture.Manifest?
verdict.dediRecord    // TrueCapture.DediRecord?
```

**Kotlin**
```kotlin
val verdict = TrueCapture.verify(file = fileByteArray, mimeType = "image/jpeg")

verdict.result        // VerifyResult.AUTHENTIC | TAMPERED | UNSIGNED
verdict.sigValid      // Boolean
verdict.hashMatch     // Boolean
verdict.manifest      // Manifest?
verdict.dediRecord    // DediRecord?
```

**React Native**
```js
const verdict = await TrueCapture.verify({
  file: base64Data,
  mimeType: 'image/jpeg',
});

verdict.result        // 'authentic' | 'tampered' | 'unsigned'
verdict.sigValid      // boolean
verdict.hashMatch     // boolean
verdict.manifest      // object | null
verdict.dediRecord    // object | null
```

---

## 4. Offline Behaviour

All signing is on-device and requires zero network connectivity. The device camera, Secure Enclave or Android Keystore, and local file system are the only dependencies during signing.

| Operation | Offline behaviour |
|-----------|-------------------|
| `captureAndSign()` | Works fully — signing proceeds normally |
| `signExistingFile()` | Works fully — signing proceeds normally |
| `editAndResign()` | Works fully — signing proceeds normally |
| `verify()` | Works for files with embedded manifest |
| Verify hash upload | Queued locally, synced on next connectivity |
| DeDi sync | Queued locally, synced on next connectivity |

**Verify links generated offline** are valid immediately using the file hash. The link resolves as pending until the queue syncs. Once synced, the link shows the full result — with no difference visible to the end user.

**Known limitation:** if the app is uninstalled before offline queues sync, key registration may be incomplete. For high-stakes use, confirm sync before uninstalling or rekey on reinstall.

---

## 5. Edit Chain (Optional)

Disabled by default. Enabled by passing `enableEditChain: true` to `TrueCapture.configure()`.

When enabled, `editAndResign()` creates a second C2PA manifest (Manifest 2) that explicitly references the original (Manifest 1). The file carries both manifests. The verify page displays the full chain: original capture details followed by each edit step.

**Adobe compatibility**

The edit chain is compatible with the Adobe C2PA pipeline. Files signed with the TrueCapture SDK and subsequently edited in Photoshop or Lightroom (with Adobe Content Credentials enabled) will have the Adobe edit appended as Manifest 3, extending the chain automatically. No additional integration is required.

**Chain breakage**

The chain breaks if the file passes through a non-C2PA tool — including WhatsApp, most social media platforms, and any image processor that strips metadata. This is a known, documented limitation of the C2PA specification and affects all C2PA implementations equally. The original manifest embedded at capture time remains intact and verifiable even after chain breakage.

**Recommendation:** enable the edit chain for organisations using Adobe Creative Cloud throughout their workflow. For organisations sharing primarily via social media, the overhead of managing the chain may not be worthwhile.

---

## 6. Integration

### iOS — Swift Package Manager

Add the SDK in Xcode: **File > Add Package Dependencies**

```
https://github.com/TanushkaCDPI/truecapture-ios-sdk
```

Initialise in `AppDelegate.swift` or `App.swift`:

```swift
import TrueCapture

TrueCapture.configure(
    orgName: "Your Organisation",
    orgDomain: "yourdomain.com",
    dediRecordId: "your-dedi-record-id"
)
```

### Android — Gradle

`build.gradle`:
```groovy
dependencies {
    implementation 'dev.truecapture:sdk:0.1.0'
}
```

Initialise in `Application.onCreate()`:

```kotlin
import dev.truecapture.TrueCapture

TrueCapture.configure(
    orgName = "Your Organisation",
    orgDomain = "yourdomain.com",
    dediRecordId = "your-dedi-record-id"
)
```

### React Native

```bash
npm install truecapture-sdk
npx pod-install   # iOS only
```

Initialise in your root component or app entry point:

```js
import TrueCapture from 'truecapture-sdk';

TrueCapture.configure({
  orgName: 'Your Organisation',
  orgDomain: 'yourdomain.com',
  dediRecordId: 'your-dedi-record-id',
});
```

### Keypair and DeDi registration

The SDK generates the device keypair automatically on first initialisation. To register your public key on DeDi.global:

1. Create an account at [dedi.global](https://dedi.global)
2. Create a namespace for your organisation
3. Call `TrueCapture.getPublicKeyPem()` to retrieve the public key from the device
4. Register it via the DeDi dashboard or API
5. Pass the resulting `record_id` to `TrueCapture.configure()`

Full instructions: [DEPLOY_YOUR_OWN.md](DEPLOY_YOUR_OWN.md)

### Verify page

Two options:

**Self-hosted:** fork [github.com/TanushkaCDPI/truecapture](https://github.com/TanushkaCDPI/truecapture), deploy the `verify/` directory to your own domain. Verify links take the form `verify.yourdomain.com/verify/[hash]`.

**Shared:** use `truecapture.global/verify/[hash]`. No setup required. Appropriate for evaluation; organisations handling sensitive content should self-host.

---

## 7. What the Organisation Controls

- Their own signing identity — `orgName` and `orgDomain` appear in every manifest
- Their own keypair — generated on-device, stored in Secure Enclave or Android Keystore, never shared
- Their own DeDi registration — independent account, independent record, revocable at any time
- Whether to enable the edit chain
- Whether to self-host the verify page
- Their own verify link domain

---

## 8. What TrueCapture Provides

**The SDK library**
Open source, MIT licensed.
[github.com/TanushkaCDPI/truecapture](https://github.com/TanushkaCDPI/truecapture)

**The verify backend**
Open source, MIT licensed. Self-host or use `truecapture.global/verify`.
[github.com/TanushkaCDPI/truecapture](https://github.com/TanushkaCDPI/truecapture)

**Nothing else.** Keypairs, DeDi registration, deployment, hosting, and infrastructure are entirely the organisation's responsibility. TrueCapture has no access to any organisation's keys, signed files, or identity.

---

## 9. Security Model

| Property | Detail |
|----------|--------|
| Key generation | On-device, on first `configure()` call |
| Key storage | iOS Secure Enclave / Android Keystore — hardware-backed, non-exportable |
| Signing algorithm | ECDSA P-256 |
| Hash algorithm | SHA-256 of raw media bytes |
| Manifest format | C2PA compliant — readable by any C2PA-compatible tool |
| Key transmission | Never — private key never leaves the device |
| TrueCapture access | None — TrueCapture cannot forge signatures on behalf of any organisation |
| Key revocation | Handled directly on DeDi.global by the organisation |
| Offline signing | Full — no network dependency for signing operations |

**Threat model note:** the security guarantee is that a valid signature proves the file was signed by whoever holds the private key registered at the DeDi record ID in the manifest. It does not prove the file depicts what it claims to depict. Social and editorial verification remain the organisation's responsibility.

---

## 10. Status

| Component | Status |
|-----------|--------|
| Web app (`truecapture.global`) | Live |
| Chrome extension | Live |
| Verify backend | Live, open source |
| SDK specification | Complete (this document) |
| iOS SDK (Swift) | In progress — first release |
| React Native bridge | In progress — first release |
| Android SDK (Kotlin) | Planned |

To discuss integration timelines, pilot deployments, or technical questions, contact [tanushka@cdpi.dev](mailto:tanushka@cdpi.dev).
