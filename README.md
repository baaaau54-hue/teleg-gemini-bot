# Telegram Gemini Bot

A Telegram webhook bot deployed as a Vercel serverless function. It supports text, images, PDFs, supported audio/video files, per-user model/system-prompt settings, conversation context, and a short activity log.

## Required Vercel environment variables

Set these for **Production**, then redeploy:

- `BOT_TOKEN` — Telegram token from BotFather. Keep it secret.
- `GEMINI_API_KEY` — Google AI Studio API key. Keep it secret.

Optional:

- `GEMINI_MODEL` — default model (defaults to `gemini-2.5-flash`). Model availability depends on your Gemini API account.
- `MAX_FILE_BYTES` — maximum Telegram media size in bytes (defaults to 15,000,000; capped at 18,000,000).
- `TELEGRAM_WEBHOOK_SECRET` — optional webhook secret. If set, configure the same value as Telegram's `secret_token` when calling `setWebhook`.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — optional Upstash Redis REST credentials for durable settings, conversation context, and logs. Without these, data is held only in the serverless instance's memory and may disappear between invocations.

## Webhook

After deployment, set Telegram's webhook URL to:

`https://<your-production-domain>/api/bot`

For example, from PowerShell (do not paste the bot token into chat):

```powershell
$token = Read-Host "BOT_TOKEN"
$webhook = "https://<your-production-domain>/api/bot"
Invoke-RestMethod -Method Post `
  -Uri "https://api.telegram.org/bot$token/setWebhook" `
  -Body @{ url = $webhook }
```

When `TELEGRAM_WEBHOOK_SECRET` is configured, include it as `secret_token` in the `setWebhook` request. Telegram accepts 1–256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`.

## Commands

- `/start`, `/help`
- `/settings` — show current model, prompt, storage status, and upload limit
- `/model <model-id>` — set a per-user Gemini model
- `/system <instructions>` — set per-user assistant instructions; `/system` clears them
- `/reset` — clear saved conversational context
- `/history` — show up to five recent activity summaries

Conversation context retains the last 10 text turns. Activity logs keep at most 20 short entries per Telegram user. Media bytes are not retained in the conversation history or logs. PDF/image/audio/video handling depends on Gemini model/API support and file-size limits. Unsupported document formats are rejected; text files are decoded as UTF-8.

## Security and privacy

Use a new token if a bot token has ever been exposed. Set secrets in Vercel environment variables, never in source code. Redis persists conversation text and activity summaries; use a private Redis database and delete keys if you need to remove stored data. The webhook endpoint can be protected with `TELEGRAM_WEBHOOK_SECRET`.
