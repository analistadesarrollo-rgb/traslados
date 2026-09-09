# AGENTS.md

WhatsApp bot that automates employee transfers between branches via a real web system (Puppeteer). Commands arrive as WhatsApp messages (`TRASLADO <DOC> <SUCURSAL>`).

## Key commands

```bash
npm install              # install deps
npm run db:init          # init SQLite schema (run once)
npm start                # run all (web + worker + whatsapp)
npm test                 # all tests (node --test)
npm run test:unit        # unit tests only (no browser)
npm run test:parser      # parser/validation only
node --test tests/automation.integration.test.js  # e2e with Puppeteer + mock HTML
```

No build step. No TypeScript. No linter configured.

## Runtime requirements

- **Node ≥ 22.5** (uses native `node:sqlite`)
- **Chrome or Chromium** installed (Puppeteer automation)
- `.env` file with `WEB_SYSTEM_USER`, `WEB_SYSTEM_PASSWORD`, `ADMIN_PASSWORD` filled in
- `npm run db:init` before first run

## Architecture (4 components, one entrypoint)

`src/index.js` runs one or more modes via flags (`--web`, `--worker`, `--whatsapp`):

1. **WhatsApp client** (`whatsapp-web.js`, LocalAuth) → receives commands
2. **TransferService** → parses, validates, enqueues (idempotent by `message_id`)
3. **Queue + Worker** → SQLite-backed (`job_queue` table), document-level locking, lease/expiry
4. **Automation** → Puppeteer against the real web system (login, search, close shift, create shift)

## Critical business rule

Shift verification is non-negotiable: **before** creating a new shift there must be **exactly 0** active shifts; **after** creating, **exactly 1**. If close verification fails, the new shift is **not** created and an error is returned. Never bypass this check.

## Web selectors

All Puppeteer selectors for the target web system (BusinessNET / JSF + PrimeFaces) are centralized in `src/config/selectors.js`. They were originally `{{ TBD }}` placeholders — verify they match the current state of the target system before assuming automation will work. If selectors are wrong, the bot returns `AUTOMATION_NOT_CONFIGURED`.

## Testing notes

- Tests use `node:test` (native runner), no external test framework.
- E2e tests run against `tests/mock/web-system.html` (local mock), **not** the real web system. No credentials needed for tests.
- If `node --test tests/` fails on Node 24, use `npm test` (has the correct glob pattern).

## Docker

- Dockerfile uses `node:22-slim` + Chromium. `CHROME_PATH=/usr/bin/chromium`.
- `docker-compose.yml` uses `network_mode: host` so the container reaches the internal web system (`192.168.60.66:8090`).
- Volumes: `data/` (WhatsApp session + SQLite), `logs/`, `screenshots/`.
- Nginx sidecar on network `red-gane-int` for production proxy.

## CI/CD

Jenkins pipeline (`Jenkinsfile`): copies `.env` from Jenkins credentials, rebuilds Docker Compose, verifies health endpoint after 10s.

## Common gotchas

- `AUTOMATION_NOT_CONFIGURED` → missing selectors in `src/config/selectors.js` or missing `WEB_SYSTEM_*` in `.env`
- QR code needed only on first WhatsApp connection (stored in `data/wa-session`)
- `ALLOWED_PHONE_NUMBERS` empty = all numbers allowed
- `WORKER_CONCURRENCY` should stay at 1 (document-level locking assumption)
