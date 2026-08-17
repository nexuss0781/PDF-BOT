# Telegram PDF Classifier Bot

This project implements a Telegram PDF classifier with a Vercel webhook layer and an optional persistent Render worker for large-file inspection. The bot forwards the original PDF to the destination channel using Telegram’s server-side `copyMessage` operation, so the application does not download the PDF merely to upload it again.

## Hierarchical classification

The classifier uses the following escalation order:

| Tier | File condition | Inspection strategy | Expected data transfer |
|---|---|---|---:|
| 1 | Up to 30 MB | Parse the file with PDF.js and inspect up to the first three pages | One bounded file read |
| 2 | Above 30 MB | Use PDF.js range transport against the local Telegram file path; fetch only the ranges required for the PDF trailer, cross-reference data, page tree, and sampled pages | Selected ranges only |
| 3 | Range parsing is inconclusive and file is within the configured fallback limit | Full parse is allowed only when `ALLOW_BOUNDED_FULL_FALLBACK=true`; the default fallback ceiling is 100 MB | One bounded full read |
| 4 | Encrypted, malformed, unresolved, or very large file | Return **Needs inspection** rather than making an unsafe binary claim | No forced full download |

The result is **Selectable** when meaningful text objects are found in the sampled pages, **Scanned** when the sampled pages contain no meaningful text, and **Needs inspection** when the PDF cannot be safely classified using the permitted strategy. The dashboard can retain this third state for operational accuracy; if a strict two-button interface is required, it can be mapped to Scanned later.

A range parser requests byte ranges, not page numbers. Ordinary PDFs may place their page tree and cross-reference data near the end of the file, while linearized PDFs are optimized for first-page access. The implementation therefore lets PDF.js request the required ranges and does not assume that the first 4.3 MB equals the first three pages.[1] [2]

## Deployment architecture

Vercel is the only application runtime. It receives Telegram webhooks, calls the external Render-hosted Telegram Bot API panel, immediately copies the PDF to the channel, fetches the remote file metadata, performs hierarchical PDF.js range inspection through the external file endpoint, and persists records in encrypted Paradox-DB SQLite. No application code is deployed to or logged into the Render panel.

The external Local Bot API panel is required for arbitrary files above the normal cloud Bot API download limit. Telegram’s Local Bot API Server supports downloads without a size limit and uploads up to 2,000 MB.[3] Vercel calls the panel remotely and never forwards the PDF by uploading a second copy; forwarding remains a Telegram-side copy.

## Environment variables

### Vercel

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather token. |
| `TELEGRAM_CHANNEL_ID` | Destination channel ID. |
| `TELEGRAM_CHANNEL_USERNAME` | Optional public username without `@`. |
| `TELEGRAM_WEBHOOK_SECRET` | Optional Telegram webhook secret header value. |
| `TELEGRAM_API_BASE` | External Render Bot API base: `https://telegram-bot-api-gl9q.onrender.com/bot`. |
| `TELEGRAM_FILE_BASE_URL` | External Render file base: `https://telegram-bot-api-gl9q.onrender.com/file`. |
| `PARADOX_GATEWAY_URL` | Normally `https://paradoxdb.onrender.com/v1`. |
| `PARADOX_API_KEY` | API key from the registered Paradox-DB account. |
| `PARADOX_PASSPHRASE` | Encryption passphrase; back it up securely. |
| `PARADOX_PROJECT` | Defaults to `telegram-pdf-bot`. |
| `PARADOX_DATABASE` | Defaults to `pdf-records`. |
| `GITHUB_TOKEN` | Optional compatibility fallback token when no worker is configured. |
| `GITHUB_REPO` | Optional fallback repository. |
| `GITHUB_BRANCH` | Optional fallback branch; defaults to `main`. |
| `GITHUB_LOG_PATH` | Optional fallback path; defaults to `data/pdf-dashboard.md`. |
| `PDFBOT_WORKER_URL` | Public URL of the isolated Render PDF-BOT service, without a trailing slash. |
| `PDFBOT_WORKER_SECRET` | Shared secret for Vercel-to-worker requests. |
| `PDFBOT_CALLBACK_URL` | Public Vercel URL ending in `/api/worker-callback`. |
| `PDFBOT_CALLBACK_SECRET` | Shared secret for worker-to-Vercel callbacks. |

### Isolated Render PDF-BOT service

Create a new Render web service from `nexuss0781/telegram-bot-api-pdf-bot` and do not modify the existing shared Bot API service. Use the Dockerfile in the repository and set the following service variables:

| Variable | Value |
|---|---|
| `PDFBOT_WORKER_ENABLED` | `true` |
| `TELEGRAM_API_ID` | The Telegram API ID used by the Local Bot API server. |
| `TELEGRAM_API_HASH` | The Telegram API hash used by the Local Bot API server. |
| `TELEGRAM_LOCAL` | `true` |
| `TELEGRAM_WORK_DIR` | `/var/lib/telegram-bot-api` |
| `TELEGRAM_TEMP_DIR` | `/tmp/telegram-bot-api` |
| `PDFBOT_WORKER_SECRET` | A long random secret matching Vercel. |
| `PORT` | Injected by Render; do not hard-code it. |

The service exposes the Bot API through the public Render URL and the worker endpoint at `/pdfbot/classify`. The worker uses the local file path returned by `getFile`, samples the first three pages with `pdfinfo` and `pdftotext`, and reports `locating`, `structure`, `sampling`, `classified`, or `failed` stages to Vercel. It does not download a second copy of the PDF.

### Existing external Render Bot API panel

The existing shared panel remains untouched and may continue serving other projects. Its values are still used as the fallback configuration:

| Variable | Value |
|---|---|
| `TELEGRAM_API_BASE` | `https://telegram-bot-api-gl9q.onrender.com/bot` |
| `TELEGRAM_FILE_BASE_URL` | `https://telegram-bot-api-gl9q.onrender.com/file` |

The complete template is in `.env.example`.

## External Render Bot API panel

The verified Render panel responds to tokenized Bot API requests such as `getMe`. Vercel calls it externally using the `/bot` base for Bot API methods and the `/file` base for file ranges. The panel may sleep on inactivity, so the Vercel code retries Bot API calls and remote range requests with backoff. No PDF binary is uploaded to Vercel by Telegram’s webhook; the webhook contains the document reference, and Vercel requests only the ranges needed for inspection.

## Telegram behavior

Users send PDFs to the bot. The bot acknowledges the upload immediately, performs the PDF.js inspection, edits that reply with the final **Scanned** or **Selectable** classification, and only then copies the original file into the destination channel. The channel copy receives a metadata caption containing the title, sender, source link, inspection strategy, and the same two inline category buttons. Pressing **Selectable PDFs** or **Scanned PDFs** in the bot chat returns every stored PDF in that category as a numbered list of links to the channel. Users can also send `/scanned`, `/selectable`, or `/selective` to open a category directly.

## Bandwidth and safety controls

The default large-file behavior is deliberately conservative. Files larger than 30 MB use range sampling; if range parsing fails, the bot returns **Needs inspection** instead of silently downloading a 300 MB file. Full fallback is disabled by default and is only permitted for files up to 100 MB when explicitly enabled. This prevents a malformed PDF from consuming the Render bandwidth budget.

If the source PDF is protected by Telegram’s no-forwarding setting, server-side copying may fail. In that case the bot should report the failure instead of attempting an application-level re-upload.

## Validation

```bash
npm install
npx tsc --noEmit
```

For local testing, run Vercel development mode:

```bash
npm run dev
```

## References

[1]: https://core.telegram.org/method/upload.getFile "Telegram MTProto upload.getFile"
[2]: https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions "Mozilla PDF.js FAQ"
[3]: https://github.com/tdlib/telegram-bot-api "Telegram Bot API Server"
