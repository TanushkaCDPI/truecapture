# Deploy Your Own TrueCapture Instance

This guide walks any organisation — a news agency, broadcaster, NGO, or independent journalist — through forking TrueCapture and running a fully independent, branded instance. Your installation uses your own keypair, your own domain, and has no dependency on TrueCapture infrastructure.

**Result:** your journalists sign content as *"Signed by [Your Organisation]"* and your readers verify it at `verify.yourdomain.com`.

---

## Prerequisites

- A GitHub account
- A [Railway](https://railway.app) account (free tier works)
- A [DeDi.global](https://dedi.global) account (free)
- A domain you control
- Node.js 20+ installed locally

---

## Step 1 — Fork the repository

```bash
# On GitHub: click Fork on https://github.com/TanushkaCDPI/truecapture
# Then clone your fork:
git clone https://github.com/YOUR_ORG/truecapture.git
cd truecapture
```

---

## Step 2 — Update branding

Replace "TrueCapture" with your organisation name in the following files:

| File | What to change |
|------|----------------|
| `verify/index.html` | Page title, nav logo text, hero copy, footer |
| `verify/landing.css` | No text changes needed |
| `verify/verify/index.html` | `<title>`, header brand name |
| `verify/sign/index.html` | `<title>`, header brand name |
| `backend/server.js` | `claim_generator: 'TrueCapture/1.0'` → `'YourOrg/1.0'` |
| `backend/server.js` | `entity.name: 'TrueCapture'` → your org name |
| `backend/server.js` | `entity.url` → your domain |
| `extension/popup.html` | Extension popup title and branding |
| `extension/manifest.json` | `"name"`, `"description"` fields |

---

## Step 3 — Generate your keypair

> ⚠️ **Never use the TrueCapture keys.** Generate your own. The keypair is what makes your signatures yours.

The backend auto-generates a keypair on first start. You can also generate one manually:

```bash
# Generate ECDSA P-256 private key
openssl ecparam -name prime256v1 -genkey -noout -out private.pem

# Extract public key
openssl ec -in private.pem -pubout -out public.pem

# Generate self-signed certificate (valid 10 years)
openssl req -new -x509 -key private.pem -out cert.pem -days 3650 \
  -subj "/CN=YourOrg Signer/O=YourOrg"
```

Place `private.pem`, `public.pem`, and `cert.pem` in `backend/.keys/` before first run. If `.keys/` is absent the server generates an RSA-2048 keypair automatically.

**Keep your private key secret.** It is listed in `.gitignore` and must never be committed.

---

## Step 4 — Register your key on DeDi.global

DeDi.global is a decentralised public key directory. Registering your key there lets anyone independently verify that a signature came from your organisation.

1. Create an account at [dedi.global](https://dedi.global)
2. Create a **namespace** (e.g. `bbc` or `reuters`)
3. Create a **registry** called `signing-keys` inside your namespace
4. Note your **API key** from the DeDi dashboard

The backend registers your public key automatically on first start, using the `DEDI_API_KEY` and `DEDI_NAMESPACE` environment variables.

For manual registration or more detail, see the [DeDi API docs](https://dedi.global/docs).

---

## Step 5 — Set environment variables

Copy the example file:

```bash
cp .env.example backend/.env
```

Edit `backend/.env`:

```env
# DeDi key registry
DEDI_API_KEY=your_dedi_api_key_here
DEDI_NAMESPACE=your_org_namespace        # e.g. "bbc" or "reuters"
DEDI_REGISTRY=signing-keys

# Your organisation
ORG_NAME=Your Organisation Name
ORG_URL=https://yourdomain.com

# URLs
VERIFY_BASE_URL=https://verify.yourdomain.com/verify
PORT=3000
HOST=0.0.0.0
```

---

## Step 6 — Deploy the backend to Railway

1. Go to [railway.app](https://railway.app) and create a new project
2. Click **Deploy from GitHub repo** → select your fork
3. Set the **Root Directory** to `backend`
4. Add all environment variables from Step 5 under **Variables**
5. Railway detects Node.js and runs `npm start` automatically
6. Note the generated Railway domain (e.g. `yourapp.up.railway.app`)

### Set a custom domain

In Railway: **Settings → Networking → Custom Domain** → add `api.yourdomain.com`

Add a CNAME record in your DNS:
```
api.yourdomain.com  CNAME  yourapp.up.railway.app
```

---

## Step 7 — Deploy the verify site to Railway

1. In Railway, add a second service to the same project
2. Set the **Root Directory** to `verify`
3. No additional environment variables needed
4. Set a custom domain: `verify.yourdomain.com` (or `www.yourdomain.com`)

Add a CNAME in DNS:
```
verify.yourdomain.com  CNAME  your-verify-service.up.railway.app
```

---

## Step 8 — Update the backend URL in the extension

Edit `extension/background.js` and `extension/capture.js`:

```js
// Change this line:
const BACKEND_URL = 'https://api.truecapture.global';

// To your backend:
const BACKEND_URL = 'https://api.yourdomain.com';
```

Also update `verify/verify/verify.js`:

```js
const BACKEND_URL = 'https://api.yourdomain.com';
```

And `verify/sign/index.html` (inline script near the top):

```js
const BACKEND_URL = 'https://api.yourdomain.com';
```

Commit and push. Railway redeploys automatically.

---

## Step 9 — Load the extension locally for testing

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder from your clone
4. Click the extension icon → try Photo, Video, or Screen capture
5. Check that signed files download and verify correctly at your domain

---

## Step 10 — Submit to the Chrome Web Store

When you're satisfied with your branded instance:

1. Zip the `extension/` folder
2. Go to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. Click **New item** → upload your zip
4. Fill in store listing: name, description, screenshots
5. Pay the one-time $5 developer registration fee (if not already registered)
6. Submit for review (typically 1–3 business days)

---

## Checklist

- [ ] Forked the repo and updated branding
- [ ] Generated your own keypair (or let the server generate one on first run)
- [ ] Registered your namespace and API key on DeDi.global
- [ ] Set all environment variables in Railway
- [ ] Backend deployed and reachable at `api.yourdomain.com`
- [ ] Verify site deployed and reachable at `verify.yourdomain.com`
- [ ] Extension updated to point to your backend URL
- [ ] Test: sign a file with the extension → verify link opens → shows "Authentic"
- [ ] `.env` and `.keys/` are **not** committed to your repo

---

## Support

Questions or issues? Open a GitHub issue on [TanushkaCDPI/truecapture](https://github.com/TanushkaCDPI/truecapture) or email [tanushka@cdpi.dev](mailto:tanushka@cdpi.dev).
