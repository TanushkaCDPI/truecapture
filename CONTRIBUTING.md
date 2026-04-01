# Contributing to TrueCapture

TrueCapture is an open source reference implementation of browser-based C2PA media signing. It is intentionally simple — the goal is that any newsroom or organisation can fork it, understand it, and deploy it in an afternoon.

PRs are welcome. Here's what's in scope.

---

## What we're looking for

**Bug fixes** — if something breaks in a real browser, on a real device, that's a priority.

**New capture modes** — the extension currently supports Photo, Video, and Screen. Additional modes (e.g. audio, PDF) that fit the same pattern are welcome.

**Mobile improvements** — the `/sign` mobile web app works but has rough edges. Better iOS/Android UX is welcome.

**Verification UX** — the verify page is functional but sparse. Improvements that make the verdict clearer to non-technical users are welcome.

**Documentation** — corrections, clearer explanations, or translations of `README.md` or `DEPLOY_YOUR_OWN.md`.

---

## What's out of scope

- Adding a user account system or database — TrueCapture is intentionally stateless
- Replacing the C2PA standard with a proprietary signing scheme
- Features that would make the codebase harder to fork and redeploy independently

---

## Design principle

**Keep it forkable.** Every file in this repo should be readable by a competent developer without documentation. If you're adding complexity, ask whether a newsroom's in-house dev team could still understand, modify, and own the code after forking. If the answer is no, simplify.

---

## Getting started

```bash
git clone https://github.com/TanushkaCDPI/truecapture.git
cd truecapture/backend
cp .env.example .env   # fill in your DeDi credentials
npm install
node server.js
```

See [README.md](README.md) for the full local setup guide.

---

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b fix/description`
2. Make your changes
3. Test manually — there are no automated tests yet (contributions welcome)
4. Open a PR with a clear description of what you changed and why

---

## What not to commit

- `.env` files or any file containing real API keys
- The `.keys/` directory or any private key material
- `node_modules/`

These are all covered by `.gitignore`, but double-check before pushing.

---

## License

By contributing you agree that your contributions will be licensed under the [MIT License](LICENSE).
