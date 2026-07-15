# Contributing to symposion

symposion is a personal tool, built and run for daily use, not a packaged product with a maintained public API. That said — bug reports, PRs, and design discussion are all welcome.

## Quick start

```bash
git clone https://github.com/nousergon/symposion.git
cd symposion
npm install
node server/index.mjs
```

No automated test suite exists yet — verify a change by actually driving the running app (create a persona, send a message, exercise the path you touched) before opening a PR. See `README.md` for the two-backend architecture.

## Scope & boundaries

- This is a **personal single-user tool**, not a hosted/multi-tenant service — PRs that add multi-tenant, auth, or billing concerns are out of scope.
- **Never commit secrets.** `.env`-style config and any real API keys are gitignored; `data/` (persona roster + conversation metadata) is also gitignored — it's local runtime state, not something to check in.
- **Fail loud, not silent.** No bare `try/except: pass` or swallowed errors — if something can legitimately fail, surface it (console.error, a thrown error, an HTTP error response), don't degrade silently.

## Pull requests

Open a PR against `main` with a clear description of what changed and why, and how you verified it (there's no CI gate yet, so this is the actual review signal). A maintainer reviews and merges.

## Licensing of contributions (DCO)

All contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/) — sign off every commit with `git commit -s`, certifying that you wrote the code or otherwise have the right to submit it under the project's MIT license. No separate CLA. Inbound = outbound: contributions are licensed under the same MIT license that covers the project (see `LICENSE`); do not submit code you cannot license under MIT.
