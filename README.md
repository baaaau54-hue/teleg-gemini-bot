# Telegram Gemini Bot

Telegram webhook bot hosted as a Vercel serverless function. It uses Google's Gemini Interactions API and supports text, images, PDFs, supported audio/video files, per-user settings, conversation continuation, Google Search grounding, admin controls, and administrator-defined commands.

## Required Vercel environment variables

Set in **Production** and redeploy:

- `BOT_TOKEN` — Telegram token; keep secret. Revoke and replace any token previously exposed.
- `GEMINI_API_KEY` — Google AI Studio API key; keep secret.
- `BOT_ADMIN_IDS` — comma-separated Telegram numeric user IDs allowed to use admin commands, e.g. `123456789,987654321`. Do not use usernames.

Optional:

- `GEMINI_MODEL` — default model, defaults to `gemini-3.8-flash`; it must be enabled for your Gemini API key.
- `GEMINI_ALLOWED_MODELS` — comma-separated model IDs users/admins may select. If omitted, any syntactically valid ID can be selected; the API determines availability.
- `MAX_FILE_BYTES` — upload limit in bytes (defaults to 15,000,000 and is capped at 18,000,000).
- `BOT_ACCESS_MODE` — `open` (default) or `allowlist`. In allowlist mode, use `BOT_ALLOWED_USER_IDS` and/or `/allow`.
- `BOT_ALLOWED_USER_IDS` — comma-separated initial Telegram IDs allowed in allowlist mode.
- `TELEGRAM_WEBHOOK_SECRET` — optional. When set, configure the same value as Telegram `secret_token` using `setWebhook`.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — optional Upstash Redis REST credentials for durable settings, previous interaction IDs, access lists, custom commands, and logs. Without Redis, state is only in a warm serverless instance's memory and may disappear between invocations.

## Deploy and Telegram webhook

The production deployment must include this code. Set Telegram's webhook URL to:

`https://<your-production-domain>/api/bot`

PowerShell example (enter the token locally; do not paste it in chat):

```powershell
$token = Read-Host "BOT_TOKEN"
$webhook = "https://<your-production-domain>/api/bot"
$body = @{ url = $webhook }
# Only if TELEGRAM_WEBHOOK_SECRET is configured in Vercel:
$body.secret_token = Read-Host "TELEGRAM_WEBHOOK_SECRET"
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$token/setWebhook" `
  -Body $body
