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
```

Do not set `$body.secret_token` if the Vercel variable is absent. Telegram's secret token must contain 1–256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`.

## User commands

- `/start`, `/help`
- `/settings` — show this user's model, memory/search setting, upload limit, feature status, and storage type
- `/model <model-id>` — choose a model (restricted by `GEMINI_ALLOWED_MODELS` if set)
- `/system <instructions>` — per-user assistant instruction; `/system` clears it
- `/memory on|off` — continue or disable server-side interaction context
- `/search on|off` — enable/disable Google Search grounding for this user
- `/reset` — clear this user's conversation continuation
- `/history` — show recent short activity records; prompts/files are not stored in logs

## Admin commands

Configure `BOT_ADMIN_IDS`, redeploy, then:

- `/admin` — show admin command help
- `/allow <telegram-id>` and `/deny <telegram-id>` — manage individual access
- `/defaultmodel <model-id>` — set a runtime default
- `/feature <text|image|document|audio|video|search> on|off` — globally enable/disable a capability
- `/custom add <name> | <instructions>` — define a custom slash command
- `/custom delete <name>` and `/custom list`

Custom commands are prompt templates, not executable code. They are available to all users allowed to use the bot. Set `BOT_ACCESS_MODE=allowlist` to require explicit access. Admins are identified only by Telegram numeric IDs from `BOT_ADMIN_IDS`.

## Media, memory, and privacy

Images, PDFs, text files, audio, and video are submitted to Gemini when supported by the selected model/API and within the configured size limit. Unsupported formats are rejected. Text document content is decoded as UTF-8. Telegram/Gemini have their own limits and model capability restrictions.

Conversation continuation uses Gemini Interactions' previous interaction ID; the ID is retained in Redis when configured. Without Redis it is ephemeral and may be lost between serverless invocations. Activity logs contain a short prompt summary, model, type, status, and timestamp; they do not contain media bytes or full assistant responses. Redis stores settings, access flags, interaction IDs, custom command templates, and logs. Use a private Redis database and apply your data-retention policy.

## Troubleshooting

If Gemini returns 404, verify that the selected model ID is available to your API key and that the deployment is using this branch/code. A successful Vercel build or GET health response does not test Telegram webhook delivery or Gemini model access. Check Vercel Runtime Logs after sending a test message.
